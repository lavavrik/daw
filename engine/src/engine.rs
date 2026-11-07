//! Engine core: owns all state, decodes commands, renders blocks.
//! `process` is the real-time callback: no allocation, no blocking, no panics.
//!
//! # Track slots
//! Each of the `MAX_TRACKS` slots is empty, a drum track or a synth track
//! ([`SlotKind`]). Adding one kind over the other first removes the old one
//! with its own 2 ms fade (drum voices fade in `Drums`, the rack fades in
//! `Synths`), so a kind swap never hard-cuts audio. Drum commands sent to a
//! synth slot, and rack commands sent to a non-synth slot, return
//! `ERR_BAD_INDEX`. Drum row/step edits on an *empty* slot still succeed and
//! just store state (plan-1 behaviour).
//!
//! # Live input
//! `NOTE_ON`/`NOTE_OFF`/`PITCH_BEND`/`MOD_WHEEL`/`SUSTAIN` go to the input
//! track's rack (`SET_INPUT_TRACK`). With no input track, or one that is not a
//! synth track, they are ignored (and still return `OK`). Switching the input
//! track sends the previous one `AllOff`, pedal up and bend 0, so no note is
//! left hanging. The engine caches the last bend / mod wheel / sustain it
//! received and replays them to the new input track, so controller state
//! follows the switch (e.g. a held pedal keeps holding). When the input slot
//! stops being a synth track (`REMOVE_TRACK`, or `ADD_DRUM_TRACK` over it) the
//! input track is unset, so a track added there later does not inherit it.
//!
//! # Note patterns
//! Each synth track plays its own [`NotePattern`](crate::sequencer::NotePattern)
//! while the transport runs (see `sequencer.rs` for the rules). Editing,
//! removing or moving a sounding note releases it; `STOP` sends `Off` for
//! every sounding *sequenced* pitch on every synth track (not `AllOff`, so
//! held live keys keep sounding). Note commands on a slot that is not a synth
//! track return `ERR_BAD_INDEX`.
//!
//! # Count-in
//! `PLAY` with `a = BAR_TICKS` starts the transport one bar early, at tick
//! −3840. While the playhead is below 0, drum steps and pattern notes do not
//! fire, and the metronome clicks even when it is off (the count-in bar
//! starts with the accent). From tick 0 on, everything plays as usual.

use crate::arena::SampleArena;
use crate::drums::Drums;
use crate::protocol::{self, Command};
use crate::samples::{Sample, SamplePool};
use crate::metronome::Metronome;
use crate::rack::modules::{Ctx, NoteEvent};
use crate::synth::Synths;
use crate::transport::{events_in_window, tick_to_offset, Transport};
use crate::{
    BAR_TICKS, MAX_BLOCK, MAX_SAMPLES, MAX_SAMPLE_FLOATS, MAX_TRACKS, PPQ, TELEMETRY_BLOCKS, TELEMETRY_LAST_ERROR,
    TELEMETRY_LEN, TELEMETRY_PEAK_L, TELEMETRY_PEAK_R, TELEMETRY_PLAYING, TELEMETRY_TICKS,
};

/// 4/4: a bar (`BAR_TICKS`) is 4 beats; beat 0 of each bar is the accent.
const BEAT_OFFSETS: [f64; 4] = [0.0, PPQ, 2.0 * PPQ, 3.0 * PPQ];

/// Initial arena size in floats (128 MB).
const ARENA_FLOATS: usize = 32 * 1024 * 1024;

/// `ERR_BAD_INDEX` unless `ok` (the target existed).
fn found(ok: bool) -> Result<(), i32> {
    if ok {
        Ok(())
    } else {
        Err(protocol::ERR_BAD_INDEX)
    }
}

/// What a track slot currently holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotKind {
    Empty,
    Drum,
    Synth,
}

/// The whole audio engine (see the module docs).
pub struct Engine {
    master_gain: f32,
    sample_rate: f32,
    transport: Transport,
    metronome: Metronome,
    telemetry: [f64; TELEMETRY_LEN],
    arena: SampleArena,
    samples: SamplePool,
    drums: Drums,
    synths: Synths,
    kinds: [SlotKind; MAX_TRACKS],
    /// Slot that receives live notes, if any.
    input: Option<usize>,
    /// Last controller values received (replayed on an input switch).
    bend: f32,
    mod_wheel: f32,
    sustain: bool,
}

impl Engine {
    /// Does all big allocations: reserves the 32 Mi-float (128 MB) sample
    /// arena and preallocates every synth track's rack.
    pub fn new(sample_rate: f32) -> Engine {
        Engine {
            master_gain: 0.8,
            sample_rate,
            transport: Transport::new(),
            metronome: Metronome::new(sample_rate),
            telemetry: [0.0; TELEMETRY_LEN],
            arena: SampleArena::with_capacity(ARENA_FLOATS),
            samples: SamplePool::new(),
            drums: Drums::new(sample_rate),
            synths: Synths::new(sample_rate),
            kinds: [SlotKind::Empty; MAX_TRACKS],
            input: None,
            bend: 0.0,
            mod_wheel: 0.0,
            sustain: false,
        }
    }

    /// Decode and apply a command. Returns 0 (OK) or a negative error code.
    /// `TELEMETRY_LAST_ERROR` holds the most recent *failed* code; successes leave it.
    /// Rack edits return the rack's own code (e.g. `ERR_BAD_VALUE` for an
    /// occupied module slot or an out-of-range param value).
    pub fn command(&mut self, op: u32, a: f64, b: f64, c: f64, d: f64) -> i32 {
        let code = match protocol::decode(op, a, b, c, d) {
            Ok(cmd) => self.handle(cmd),
            Err(e) => e,
        };
        if code != protocol::OK {
            self.telemetry[TELEMETRY_LAST_ERROR] = code as f64;
        }
        code
    }

    /// Kind of `slot` (`Empty` for an out-of-range slot; decode prevents that).
    fn kind(&self, slot: usize) -> SlotKind {
        self.kinds.get(slot).copied().unwrap_or(SlotKind::Empty)
    }

    /// Drum commands are refused on synth slots.
    fn drum_slot(&self, slot: usize) -> Result<(), i32> {
        if self.kind(slot) == SlotKind::Synth {
            Err(protocol::ERR_BAD_INDEX)
        } else {
            Ok(())
        }
    }

    /// Pattern commands are only accepted on synth slots.
    fn synth_slot(&self, slot: usize) -> Result<(), i32> {
        if self.kind(slot) == SlotKind::Synth {
            Ok(())
        } else {
            Err(protocol::ERR_BAD_INDEX)
        }
    }

    /// The rack of synth track `slot`, or `ERR_BAD_INDEX`.
    fn rack(&mut self, slot: usize) -> Result<&mut crate::rack::Rack, i32> {
        if self.kind(slot) != SlotKind::Synth {
            return Err(protocol::ERR_BAD_INDEX);
        }
        self.synths.rack_mut(slot).ok_or(protocol::ERR_BAD_INDEX)
    }

    /// Send a live event to the input track (ignored without one).
    fn live(&mut self, ev: NoteEvent) {
        if let Some(slot) = self.input {
            if self.kind(slot) == SlotKind::Synth {
                self.synths.note(slot, ev);
            }
        }
    }

    /// Remove whatever `slot` holds, each kind with its own 2 ms fade.
    fn clear_slot(&mut self, slot: usize) {
        match self.kind(slot) {
            SlotKind::Drum => self.drums.remove_track(slot),
            SlotKind::Synth => {
                // The rack is cleared (with a fade), so its notes go anyway;
                // unset the input so a later track there does not inherit it.
                self.synths.remove_track(slot);
                if self.input == Some(slot) {
                    self.input = None;
                }
            }
            SlotKind::Empty => {}
        }
        self.set_kind(slot, SlotKind::Empty);
    }

    /// Record `slot`'s kind (`get_mut`-guarded: never panics).
    fn set_kind(&mut self, slot: usize, kind: SlotKind) {
        if let Some(k) = self.kinds.get_mut(slot) {
            *k = kind;
        }
    }

    /// Apply a decoded command; returns `OK` or an `ERR_*` code.
    fn handle(&mut self, cmd: Command) -> i32 {
        match self.apply(cmd) {
            Ok(()) => protocol::OK,
            Err(code) => code,
        }
    }

    fn apply(&mut self, cmd: Command) -> Result<(), i32> {
        // Rack methods return OK or an ERR_* code; turn that into a Result.
        let rack_code = |code: i32| if code == protocol::OK { Ok(()) } else { Err(code) };
        match cmd {
            // MIDI convention: NoteOn with velocity 0 is a NoteOff.
            Command::NoteOn { note, velocity: 0 } => self.live(NoteEvent::Off { note }),
            Command::NoteOn { note, velocity } => self.live(NoteEvent::On { note, vel: velocity }),
            Command::NoteOff { note } => self.live(NoteEvent::Off { note }),
            Command::PitchBend { value } => {
                self.bend = value;
                self.live(NoteEvent::Bend(value))
            }
            Command::ModWheel { value } => {
                self.mod_wheel = value;
                self.live(NoteEvent::Mod(value))
            }
            Command::Sustain { on } => {
                self.sustain = on;
                self.live(NoteEvent::Sustain(on))
            }
            // Old track: everything off, pedal up, bend centred. New track:
            // the cached controller state.
            Command::SetInputTrack { slot } => {
                if slot != self.input {
                    self.live(NoteEvent::AllOff);
                    self.live(NoteEvent::Sustain(false));
                    self.live(NoteEvent::Bend(0.0));
                    self.input = slot;
                    self.live(NoteEvent::Bend(self.bend));
                    self.live(NoteEvent::Mod(self.mod_wheel));
                    self.live(NoteEvent::Sustain(self.sustain));
                }
            }
            Command::SetMasterGain { gain } => self.master_gain = gain,
            // Already playing: no-op (does not restart, count-in ignored).
            // Otherwise starts at -count_in (the playhead is 0 after Stop).
            Command::Play { count_in } => {
                if !self.transport.playing {
                    self.transport.ticks = -count_in;
                    self.transport.playing = true;
                }
                self.sync_transport_telemetry();
            }
            Command::Stop => {
                self.transport.playing = false;
                self.transport.ticks = 0.0;
                self.drums.fade_all(); // no hard cuts: 2 ms fade-out
                self.synths.release_sequenced(); // releases, never AllOff
                self.sync_transport_telemetry();
            }
            // Applies from the next block; the playhead position is unchanged.
            Command::SetTempo { bpm } => self.transport.bpm = bpm,
            Command::SetMetronome { on } => self.metronome.on = on,
            // Resets the slot to defaults and silences its voices (a synth
            // track there fades out first).
            Command::AddDrumTrack { slot } => {
                if self.kind(slot) == SlotKind::Synth {
                    self.clear_slot(slot);
                }
                self.drums.add_track(slot);
                self.set_kind(slot, SlotKind::Drum);
            }
            // Empty patch (a drum track there fades out first; a synth patch
            // there is cleared with a fade).
            Command::AddSynthTrack { slot } => {
                if self.kind(slot) == SlotKind::Drum {
                    self.clear_slot(slot);
                }
                self.synths.add_track(slot);
                self.set_kind(slot, SlotKind::Synth);
            }
            // Works for both kinds (and is a no-op on an empty slot, except
            // that drum state is marked inactive as before).
            Command::RemoveTrack { slot } => {
                self.clear_slot(slot);
                self.drums.remove_track(slot);
            }
            // Row/step edits on an inactive slot succeed and just store state.
            // Steps are stored for any step < MAX_STEPS (decode checks that),
            // even beyond step_count.
            Command::SetRowSample { slot, row, sample } => {
                self.drum_slot(slot)?;
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.sample = sample;
                }
            }
            Command::SetRowGain { slot, row, gain } => {
                self.drum_slot(slot)?;
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.gain = gain;
                }
            }
            Command::SetRowPan { slot, row, pan } => {
                self.drum_slot(slot)?;
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.pan = pan;
                }
            }
            Command::SetRowMute { slot, row, mute } => {
                self.drum_slot(slot)?;
                self.drums.set_row_mute(slot, row, mute)
            }
            Command::SetStep { slot, row, step, velocity } => {
                self.drum_slot(slot)?;
                if let Some(r) = self.drums.row_mut(slot, row) {
                    if let Some(s) = r.steps.get_mut(step) {
                        *s = velocity;
                    }
                }
            }
            Command::SetStepCount { slot, count } => {
                self.drum_slot(slot)?;
                if let Some(t) = self.drums.tracks.get_mut(slot) {
                    t.step_count = count;
                }
            }
            // Latched at the next step-pair boundary while playing (R12).
            Command::SetSwing { slot, swing } => {
                self.drum_slot(slot)?;
                self.drums.set_swing(slot, swing, self.transport.playing)
            }
            Command::RackAddModule { slot, module, kind } => rack_code(self.rack(slot)?.add_module(module, kind))?,
            Command::RackRemoveModule { slot, module } => rack_code(self.rack(slot)?.remove_module(module))?,
            Command::RackConnect { slot, from, to } => rack_code(self.rack(slot)?.connect(from, to))?,
            Command::RackDisconnect { slot, to } => rack_code(self.rack(slot)?.disconnect(to))?,
            Command::RackSetParam { slot, module, param, value } => {
                rack_code(self.rack(slot)?.set_param(module, param, value))?
            }
            Command::RackClear { slot } => self.rack(slot)?.clear(),
            // Pattern edits (synth slots only; `Synths` returns false for an
            // inactive track, which a synth slot never is).
            Command::NoteSet { slot, idx, note } => {
                self.synth_slot(slot)?;
                found(self.synths.set_note(slot, idx, note))?
            }
            Command::NoteRemove { slot, idx } => {
                self.synth_slot(slot)?;
                found(self.synths.remove_note(slot, idx))?
            }
            Command::NoteClear { slot } => {
                self.synth_slot(slot)?;
                found(self.synths.clear_notes(slot))?
            }
            Command::SetPatternBars { slot, bars } => {
                self.synth_slot(slot)?;
                found(self.synths.set_pattern_bars(slot, bars))?
            }
        }
        Ok(())
    }

    /// Render one block, overwriting both buffers. Frames beyond
    /// `MAX_BLOCK` or beyond the shorter buffer are zeroed, never panicking.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let n = left.len().min(right.len()).min(MAX_BLOCK);
        self.render_metronome(&mut left[..n], &mut right[..n]);
        self.render_drums(&mut left[..n], &mut right[..n]);
        self.render_synths(&mut left[..n], &mut right[..n]);
        let (mut pl, mut pr) = (0.0f32, 0.0f32);
        for i in 0..n {
            let l = (left[i] * self.master_gain).clamp(-1.0, 1.0);
            let r = (right[i] * self.master_gain).clamp(-1.0, 1.0);
            left[i] = l;
            right[i] = r;
            pl = pl.max(l.abs());
            pr = pr.max(r.abs());
        }
        self.transport.advance(n, self.sample_rate);
        self.telemetry[TELEMETRY_BLOCKS] += 1.0;
        self.sync_transport_telemetry();
        self.telemetry[TELEMETRY_PEAK_L] = pl as f64;
        self.telemetry[TELEMETRY_PEAK_R] = pr as f64;
    }

    /// Playing (0/1) and the playhead ticks at the start of the next block.
    fn sync_transport_telemetry(&mut self) {
        self.telemetry[TELEMETRY_PLAYING] = if self.transport.playing { 1.0 } else { 0.0 };
        self.telemetry[TELEMETRY_TICKS] = self.transport.ticks;
    }

    /// Metronome: trigger clicks at their exact sample offsets, rendering the
    /// segments between them so a click spilling past the block end continues
    /// next block. Does not advance the transport. During the count-in
    /// (ticks < 0) it clicks even when off; when off, the window is cut at
    /// tick 0 so the first downbeat does not click.
    fn render_metronome(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        let mut starts = [(0usize, false); 4];
        let mut count = 0;
        let (t0, t1) = self.transport.block_window(n, self.sample_rate);
        if self.transport.playing && (self.metronome.on || t0 < 0.0) && n > 0 {
            let spt = self.transport.samples_per_tick(self.sample_rate);
            let end = if self.metronome.on { t1 } else { t1.min(0.0) };
            // `events_in_window` ignores negative ticks; shift by whole bars
            // (beats and accents are unchanged) and shift the ticks back.
            let shift = if t0 < 0.0 { (-t0 / BAR_TICKS).ceil() * BAR_TICKS } else { 0.0 };
            events_in_window(t0 + shift, end + shift, BAR_TICKS, &BEAT_OFFSETS, |beat, tick| {
                if count < starts.len() {
                    starts[count] = (tick_to_offset(tick - shift, t0, spt, n), beat == 0);
                    count += 1;
                }
            });
        }
        let mut pos = 0;
        for &(at, accent) in &starts[..count] {
            let at = at.max(pos);
            self.metronome.render_add(&mut left[pos..at], &mut right[pos..at]);
            pos = at;
            self.metronome.trigger(accent);
        }
        self.metronome.render_add(&mut left[pos..], &mut right[pos..]);
    }

    /// Drums: new hits are placed at their exact sample offsets while playing
    /// (same pattern as the metronome); tails keep rendering after Stop.
    /// Steps before tick 0 (count-in) never fire: `events_in_window` skips
    /// negative ticks.
    fn render_drums(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        let window = if self.transport.playing && n > 0 {
            let (t0, t1) = self.transport.block_window(n, self.sample_rate);
            Some((t0, t1, self.transport.samples_per_tick(self.sample_rate)))
        } else {
            None
        };
        self.drums.render_add(window, &self.samples, &self.arena, left, right);
    }

    /// Synth tracks, with a `Ctx` from the transport at the block start (its
    /// ticks are negative during the count-in; synced LFOs handle that) and,
    /// while playing, the block's tick window for the patterns. Every active
    /// track renders, playing or not (see `synth.rs`).
    fn render_synths(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let spt = self.transport.samples_per_tick(self.sample_rate);
        let ctx = Ctx {
            sr: self.sample_rate,
            bpm: self.transport.bpm,
            playing: self.transport.playing,
            ticks: self.transport.ticks,
            ticks_per_frame: if spt > 0.0 && spt.is_finite() { 1.0 / spt } else { 0.0 },
        };
        let window = if self.transport.playing && n > 0 {
            let (t0, t1) = self.transport.block_window(n, self.sample_rate);
            Some((t0, t1, spt))
        } else {
            None
        };
        self.synths.render_add(&ctx, window, left, right);
    }

    fn fail(&mut self, code: i32) -> i32 {
        self.telemetry[TELEMETRY_LAST_ERROR] = code as f64;
        code
    }

    /// Reserve space for sample `id` (planar `[L..., R...]`, `frames*channels`
    /// floats) and return a pointer the UI fills, then call `sample_ready`.
    /// Replaces any existing sample in the slot (old data leaks until reset)
    /// and marks it not ready. May grow the heap only while stopped; while
    /// playing and out of room, returns `ERR_DEFERRED` so the caller retries
    /// after stopping; if growing fails (WASM memory exhausted), returns
    /// `ERR_OUT_OF_MEMORY` instead of trapping. Failures also land in
    /// `TELEMETRY_LAST_ERROR`.
    pub fn sample_alloc(&mut self, id: u32, frames: u32, channels: u32) -> Result<*mut f32, i32> {
        if id as usize >= MAX_SAMPLES {
            return Err(self.fail(protocol::ERR_BAD_INDEX));
        }
        if frames == 0 || !(1..=2).contains(&channels) {
            return Err(self.fail(protocol::ERR_BAD_VALUE));
        }
        // Reject absurd sizes before touching the arena (and without overflow
        // on wasm32's 32-bit usize): at most 64 Mi floats per sample.
        let Some(len) = (frames as usize)
            .checked_mul(channels as usize)
            .filter(|&n| n <= MAX_SAMPLE_FLOATS)
        else {
            return Err(self.fail(protocol::ERR_BAD_VALUE));
        };
        let may_grow = !self.transport.playing;
        let Some(slice) = self.arena.alloc(len, may_grow) else {
            // Without growth the only failure is "no room yet"; with growth
            // allowed, failure means the heap could not grow.
            let code = if may_grow { protocol::ERR_OUT_OF_MEMORY } else { protocol::ERR_DEFERRED };
            return Err(self.fail(code));
        };
        self.samples.set(
            id as usize,
            Sample { slice, frames: frames as usize, channels: channels as u8, ready: false },
        );
        Ok(self.arena.slice_mut(slice).as_mut_ptr())
    }

    /// Mark sample `id` playable (voices ignore samples that are not ready).
    pub fn sample_ready(&mut self, id: u32) -> i32 {
        if (id as usize) < MAX_SAMPLES && self.samples.mark_ready(id as usize) {
            protocol::OK
        } else {
            self.fail(protocol::ERR_BAD_INDEX)
        }
    }

    pub fn telemetry(&self) -> &[f64; TELEMETRY_LEN] {
        &self.telemetry
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        OP_NOTE_OFF, OP_NOTE_ON, OP_PLAY, OP_SET_METRONOME, OP_SET_TEMPO, OP_STOP,
    };

    const SR: f32 = 48000.0;

    fn render(e: &mut Engine, frames: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        for _ in 0..frames / 128 {
            e.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        out
    }

    #[test]
    fn sample_alloc_rejects_bad_args() {
        let mut e = Engine::new(SR);
        assert_eq!(e.sample_alloc(MAX_SAMPLES as u32, 10, 1), Err(protocol::ERR_BAD_INDEX));
        assert_eq!(e.sample_alloc(0, 0, 1), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.sample_alloc(0, 10, 0), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.sample_alloc(0, 10, 3), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.telemetry()[7], protocol::ERR_BAD_VALUE as f64); // sticky
        assert_eq!(e.sample_ready(5), protocol::ERR_BAD_INDEX); // nothing allocated
        assert_eq!(e.sample_ready(MAX_SAMPLES as u32), protocol::ERR_BAD_INDEX);
        // valid alloc: pointer is writable, ready flips playable
        let p = e.sample_alloc(5, 100, 2).unwrap();
        assert!(!p.is_null());
        assert!(e.samples.playable(&e.arena, 5).is_none());
        assert_eq!(e.sample_ready(5), protocol::OK);
        assert_eq!(e.samples.playable(&e.arena, 5).unwrap().0.len(), 200);
        // re-alloc replaces and un-readies
        e.sample_alloc(5, 50, 1).unwrap();
        assert!(e.samples.playable(&e.arena, 5).is_none());
    }

    #[test]
    fn silence_by_default() {
        let mut e = Engine::new(SR);
        assert!(render(&mut e, 128).iter().all(|&s| s == 0.0));
    }

    #[test]
    fn peak_telemetry_tracks_output() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 0.0);
        e.command(OP_SET_INPUT_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        render(&mut e, 4800);
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        e.process(&mut l, &mut r);
        let pk = l.iter().fold(0.0f32, |m, x| m.max(x.abs())) as f64;
        // Sine at env ~0.73 (decaying to 0.7) * Out 0.8 * master 0.8.
        assert!(pk > 0.3 && pk <= 0.64 + 1e-6, "{pk}");
        assert_eq!(e.telemetry()[5], pk);
        assert_eq!(e.telemetry()[6], pk);
        assert_eq!(e.telemetry()[0], 38.0);
    }

    #[test]
    fn bad_command_returns_error_and_keeps_rendering() {
        let mut e = Engine::new(SR);
        assert_eq!(e.command(999, 0.0, 0.0, 0.0, 0.0), -1);
        synth_patch(&mut e, 0.0);
        e.command(OP_SET_INPUT_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        let s = render(&mut e, 4800);
        assert!(s.iter().any(|&x| x != 0.0));
        assert_eq!(e.telemetry()[7], -1.0);
        // successes do not reset the last-error slot
        assert_eq!(e.command(OP_NOTE_OFF, 69.0, 0.0, 0.0, 0.0), 0);
        assert_eq!(e.telemetry()[7], -1.0);
    }

    /// Sample indices where a click begins (first nonzero sample, tolerant of
    /// the sine starting at phase 0), found by a gap of silence before it.
    fn onsets(s: &[f32]) -> Vec<usize> {
        let mut v = Vec::new();
        let mut last_nz: Option<usize> = None;
        for (i, &x) in s.iter().enumerate() {
            if x != 0.0 {
                if last_nz.map_or(true, |l| i - l > 200) {
                    v.push(i);
                }
                last_nz = Some(i);
            }
        }
        v
    }

    fn upward_crossings(s: &[f32]) -> usize {
        (1..s.len()).filter(|&i| s[i - 1] < 0.0 && s[i] >= 0.0).count()
    }

    fn start_metronome(bpm: f64) -> Engine {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, bpm, 0.0, 0.0, 0.0);
        e.command(OP_SET_METRONOME, 1.0, 0.0, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        e
    }

    #[test]
    fn metronome_clicks_on_beats() {
        let mut e = start_metronome(120.0);
        let s = render(&mut e, 96000); // 2 s
        let on = onsets(&s);
        assert_eq!(on.len(), 4, "{on:?}");
        for (got, want) in on.iter().zip([0usize, 24000, 48000, 72000]) {
            assert!((*got as i64 - want as i64).abs() <= 1, "{got} vs {want}");
        }
        // 1500 Hz accent on beat 1 (30 cycles in 20 ms), 1000 Hz after (20).
        let c0 = upward_crossings(&s[on[0]..on[0] + 960]);
        let c1 = upward_crossings(&s[on[1]..on[1] + 960]);
        assert!((29..=30).contains(&c0), "accent crossings {c0}");
        assert!((19..=20).contains(&c1), "beat crossings {c1}");
        // 0.3 amplitude * 0.8 master
        let pk = s.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(pk > 0.15 && pk <= 0.24 + 1e-6, "peak {pk}");
    }

    #[test]
    fn bar_accent_repeats_every_four_beats() {
        let mut e = start_metronome(120.0);
        let s = render(&mut e, 48000 * 3); // beats 0..5
        let on = onsets(&s);
        assert_eq!(on.len(), 6);
        let c4 = upward_crossings(&s[on[4]..on[4] + 960]);
        assert!((29..=30).contains(&c4), "beat 5 should accent, got {c4}");
    }

    #[test]
    fn click_spills_across_block_boundary() {
        // 124 bpm, odd block size via 128-frame blocks: click 2 starts mid-block
        // and must keep sounding into following blocks without a gap.
        let mut e = start_metronome(124.0);
        let s = render(&mut e, 128 * 400);
        let on = onsets(&s);
        let o = on[1];
        assert!(o % 128 != 0 || on[2] % 128 != 0);
        assert!(s[o..o + 900].iter().filter(|&&x| x == 0.0).count() < 30);
    }

    #[test]
    fn silent_when_disabled_or_stopped() {
        let mut e = Engine::new(SR);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        assert!(render(&mut e, 48000).iter().all(|&x| x == 0.0)); // metronome off
        let mut e = Engine::new(SR);
        e.command(OP_SET_METRONOME, 1.0, 0.0, 0.0, 0.0);
        assert!(render(&mut e, 48000).iter().all(|&x| x == 0.0)); // not playing
    }

    #[test]
    fn telemetry_tracks_playing_and_playhead() {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render(&mut e, 128);
        assert_eq!(e.telemetry()[1], 1.0);
        assert!((e.telemetry()[2] - 128.0 / 25.0).abs() < 1e-9);
    }

    #[test]
    fn play_while_playing_does_not_restart() {
        let mut e = Engine::new(SR);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render(&mut e, 1280);
        let t = e.telemetry()[2];
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render(&mut e, 128);
        assert!(e.telemetry()[2] > t);
    }

    #[test]
    fn stop_resets_to_zero() {
        let mut e = start_metronome(120.0);
        render(&mut e, 4800);
        assert!(e.telemetry()[2] > 0.0);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        assert_eq!(e.telemetry()[1], 0.0);
        assert_eq!(e.telemetry()[2], 0.0);
        render(&mut e, 4800); // let any tail finish
        assert_eq!(e.telemetry()[2], 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 2400);
        assert_eq!(onsets(&s)[0], 1); // restarts from tick 0 with a click
    }

    #[test]
    fn tempo_change_mid_play_keeps_steps_exact() {
        let mut e = start_metronome(120.0);
        let mut s = render(&mut e, 48000); // 1 s at 120 = 2 beats
        e.command(OP_SET_TEMPO, 128.0, 0.0, 0.0, 0.0);
        s.extend(render(&mut e, 48000 * 3)); // 3 s at 128 = 6.4 beats
        // 8.4 beats elapsed -> onsets at beats 0..=8
        let on = onsets(&s);
        assert_eq!(on.len(), 9, "{on:?}");
        for w in on.windows(2) {
            assert!(w[1] - w[0] > 11000, "onsets too close: {on:?}");
        }
        // Exact positions: beat 2 at 48000, then 22500 samples per beat.
        for k in 2..=8usize {
            let want = 48000.0 + (k as f64 - 2.0) * 22500.0;
            assert!((on[k] as f64 - want).abs() <= 1.0, "beat {k}: {} vs {want}", on[k]);
        }
        // Playhead never jumped: 8.4 beats = 8064 ticks.
        assert!((e.telemetry()[2] - 8064.0).abs() < 1e-6);
    }

    // ---- drums -----------------------------------------------------------

    use crate::protocol::{
        OP_ADD_DRUM_TRACK, OP_REMOVE_TRACK, OP_SET_ROW_GAIN, OP_SET_ROW_MUTE, OP_SET_ROW_PAN,
        OP_SET_ROW_SAMPLE,
        OP_SET_STEP, OP_SET_STEP_COUNT, OP_SET_SWING,
    };

    /// Load a mono sample of `frames` copies of `v` into slot `id` (ready).
    fn load_const(e: &mut Engine, id: u32, frames: u32, v: f32) {
        let p = e.sample_alloc(id, frames, 1).unwrap();
        unsafe { std::slice::from_raw_parts_mut(p, frames as usize) }.fill(v);
        assert_eq!(e.sample_ready(id), 0);
    }

    /// Track `slot` with `sample` on row 0 and hits (vel 127) on `steps`.
    fn drum_setup(e: &mut Engine, slot: f64, sample: f64, steps: &[f64]) {
        assert_eq!(e.command(OP_ADD_DRUM_TRACK, slot, 0.0, 0.0, 0.0), 0);
        assert_eq!(e.command(OP_SET_ROW_SAMPLE, slot, 0.0, sample, 0.0), 0);
        for &s in steps {
            assert_eq!(e.command(OP_SET_STEP, slot, 0.0, s, 127.0), 0);
        }
    }

    fn render2(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut ol, mut or) = (Vec::new(), Vec::new());
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        for _ in 0..frames / 128 {
            e.process(&mut l, &mut r);
            ol.extend_from_slice(&l);
            or.extend_from_slice(&r);
        }
        (ol, or)
    }

    /// First sample index >= `from` that is nonzero.
    fn first_nz(s: &[f32], from: usize) -> Option<usize> {
        (from..s.len()).find(|&i| s[i] != 0.0)
    }

    fn drum_engine() -> Engine {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        load_const(&mut e, 0, 10, 1.0);
        e
    }

    #[test]
    fn four_on_the_floor_onsets_exact() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[0.0, 4.0, 8.0, 12.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, r) = render2(&mut e, 96000 + 128);
        let on = onsets(&l);
        assert_eq!(on, vec![0, 24000, 48000, 72000, 96000]);
        let want = 0.5f32.sqrt() * 0.8;
        for &o in &on {
            assert!((l[o] - want).abs() < 1e-4, "{}", l[o]);
            assert!((r[o] - want).abs() < 1e-4);
        }
        assert_eq!(l, r);
    }

    #[test]
    fn swing_delays_odd_steps() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[1.0]);
        e.command(OP_SET_SWING, 0.0, 0.5, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 12800);
        assert_eq!(onsets(&l), vec![6000 + 1500]);
    }

    #[test]
    fn pan_hard_left() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_SET_ROW_PAN, 0.0, 0.0, -1.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, r) = render2(&mut e, 256);
        assert!((l[0] - 0.8).abs() < 1e-4);
        assert!(r.iter().all(|&x| x.abs() < 1e-6));
    }

    #[test]
    fn muted_row_is_silent() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[0.0, 4.0]);
        e.command(OP_SET_ROW_MUTE, 0.0, 0.0, 1.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, r) = render2(&mut e, 48000);
        assert!(l.iter().chain(r.iter()).all(|&x| x == 0.0));
    }

    /// R11: a retrigger over a sounding voice starts the new hit at FULL level
    /// (its attack is the sample's own content, exactly as for a first hit);
    /// only the old voice fades out, over exactly 96 samples (2 ms at 48 kHz).
    /// The new voice's contribution is known (constant sample), so subtracting
    /// it leaves the old voice alone, which must continue from its pre-retrigger
    /// level and ramp smoothly to silence.
    #[test]
    fn retrigger_declicks() {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0, 1.0]);
        // Half gain so old + new voice (2v) stays under the master clamp.
        assert_eq!(e.command(OP_SET_ROW_GAIN, 0.0, 0.0, 0.5, 0.0), 0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 128 * 46); // 5888 frames
        // Single-sample blocks from 5888 find exactly when the old voice's
        // fade starts and ends: it must be exactly 96 samples long.
        let mut l = l;
        let (mut first_live, mut first_dead) = (None, None);
        for i in 5888..6400usize {
            let (mut a, mut b) = ([0.0f32; 1], [0.0f32; 1]);
            e.process(&mut a, &mut b);
            l.push(a[0]);
            let live = e.drums.tracks[0].voices[0].fading.live_for_test();
            if live && first_live.is_none() {
                first_live = Some(i);
            }
            if !live && first_live.is_some() && first_dead.is_none() {
                first_dead = Some(i);
            }
        }
        let (f, d) = (first_live.unwrap(), first_dead.unwrap());
        assert!((5999..=6000).contains(&f), "retrigger at ~6000, got {f}");
        assert_eq!(d - f, 95, "fade lasts exactly 96 samples (live through 95 processed)");
        // v = one voice at gain 0.5, centre pan, 0.8 master.
        let v: f32 = 0.5 * 0.5f32.sqrt() * 0.8;
        assert!((l[f - 1] - v).abs() < 1e-4, "before the retrigger: one voice");
        // New voice at full level from its very first sample (no fade-in).
        assert!((l[f] - 2.0 * v).abs() < 1e-4, "old (still full) + new (full): {}", l[f]);
        // Old voice alone = output - new voice.
        let old: Vec<f32> = (f..f + 200).map(|i| l[i] - v).collect();
        assert!((old[0] - v).abs() < 1e-4, "old voice continues at its level");
        for w in old.windows(2) {
            assert!(w[1] <= w[0] + 1e-6, "old voice only ramps down");
            assert!(w[0] - w[1] <= v / 96.0 + 1e-4, "old voice ramps smoothly: {:?}", w);
        }
        assert!(old.iter().all(|&x| x >= -1e-5), "never below 0 (would mean a fade-in)");
        assert!(old[96..].iter().all(|&x| x.abs() < 1e-5), "old voice silent after 96");
        assert!(old[90] > 0.0);
        assert!((l[6100] - v).abs() < 1e-4);
        assert!(e.drums.tracks[0].voices[0].active.live_for_test());
    }

    /// R12: swing is latched per track and only changes when the playhead
    /// crosses a step-pair boundary (multiple of 2*STEP_TICKS), so an odd step
    /// can never jump across the playhead: no double fire, no skip.
    #[test]
    fn swing_change_mid_play_never_double_fires_or_skips() {
        // 120 bpm: a step is 6000 samples, a pair 12000, a 16-step loop 96000.
        // (a) Step 1 has just fired (swing 0, at 6000); more swing would move
        //     it to 6300, *after* the playhead: it must not fire again. The new
        //     swing applies from the next pair (step 3 at 18000 + 300).
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[1.0, 3.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let mut l = render2(&mut e, 128 * 47).0; // 6016: step 1 fired
        assert_eq!(e.command(OP_SET_SWING, 0.0, 0.1, 0.0, 0.0), 0);
        l.extend(render2(&mut e, 128 * 853).0); // to 115200
        assert_eq!(onsets(&l), vec![6000, 18300, 102300, 114300]);

        // (b) Swing 0.5 puts step 1 at 7500; removing swing just before it
        //     would move it to 6000, *behind* the playhead: it must still fire
        //     (at 7500), and the new swing applies from the next pair.
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[1.0, 3.0]);
        e.command(OP_SET_SWING, 0.0, 0.5, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let mut l = render2(&mut e, 128 * 55).0; // 7040: step 1 not yet fired
        assert_eq!(e.command(OP_SET_SWING, 0.0, 0.0, 0.0, 0.0), 0);
        l.extend(render2(&mut e, 128 * 845).0); // to 115200
        assert_eq!(onsets(&l), vec![7500, 18000, 102000, 114000]);

        // (c) A small nudge mid-crossfade must not double-fire either (that
        //     hard-cut the fading voice): with a long sample, step 1 retriggers
        //     over step 0 once, so the fading slot is used exactly once.
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0, 1.0]);
        e.command(OP_SET_SWING, 0.0, 0.2, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 128 * 50); // 6400: step 1 (at 6600) not yet
        // Count triggers: the active voice's read position restarts at 0.
        let mut l = Vec::new();
        let mut triggers = 0;
        let mut last_pos = e.drums.tracks[0].voices[0].active.pos_for_test();
        for i in 6400..9000usize {
            let (mut a, mut b) = ([0.0f32; 1], [0.0f32; 1]);
            e.process(&mut a, &mut b);
            l.push(a[0]);
            if i == 6610 {
                // just after step 1 fired at 6600: nudge swing +1% (-> 6630)
                assert_eq!(e.command(OP_SET_SWING, 0.0, 0.21, 0.0, 0.0), 0);
            }
            let pos = e.drums.tracks[0].voices[0].active.pos_for_test();
            if pos < last_pos {
                triggers += 1;
            }
            last_pos = pos;
        }
        assert_eq!(triggers, 1, "step 1 fires exactly once");
        // After the fade, the output is one steady voice.
        let v: f32 = 0.5f32.sqrt() * 0.8;
        assert!(l[400..].iter().all(|&x| (x - v).abs() < 1e-4));
    }

    #[test]
    fn stop_fades_out_in_2ms() {
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 1280);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 256);
        let v: f32 = 0.5f32.sqrt() * 0.8;
        assert!((l[0] - v).abs() < 1e-4, "starts from the current level");
        assert!(l.windows(2).all(|w| w[1] <= w[0] && w[0] - w[1] <= 0.1));
        assert!(l[96..].iter().all(|&x| x == 0.0), "silent by 96 samples");
        assert!(l[90] > 0.0);
    }

    #[test]
    fn shrinking_step_count_wraps_playhead() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_SET_STEP_COUNT, 0.0, 64.0, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        // step 40 starts at 40 * 6000 samples
        render2(&mut e, 128 * 1876); // 240128 frames
        e.command(OP_SET_STEP_COUNT, 0.0, 16.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 96000); // one 16-step loop is 96000
        let o = first_nz(&l, 0).expect("hit within one loop");
        // playhead 240128 samples = 9605.12 ticks; mod 3840 = 1925.12; next loop
        // start in 1914.88 ticks = 47872 samples
        assert!((o as i64 - 47872).abs() <= 1, "{o}");
    }

    #[test]
    fn tracks_loop_independently() {
        let mut e = drum_engine();
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        drum_setup(&mut e, 1.0, 0.0, &[0.0]);
        e.command(OP_SET_ROW_PAN, 0.0, 0.0, -1.0, 0.0); // A -> left only
        e.command(OP_SET_ROW_PAN, 1.0, 0.0, 1.0, 0.0); // B -> right only
        e.command(OP_SET_STEP_COUNT, 1.0, 32.0, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, r) = render2(&mut e, 192000 + 256);
        assert_eq!(onsets(&l), vec![0, 96000, 192000]);
        assert_eq!(onsets(&r), vec![0, 192000]);
    }

    #[test]
    fn add_track_resets_and_remove_fades() {
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_SET_ROW_PAN, 0.0, 0.0, -1.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 1280);
        e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 256);
        assert!(l[0] > 0.5 && l[96..].iter().all(|&x| x == 0.0));
        // re-adding resets everything (no sample, no steps, no pan)
        e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0);
        let t = &e.drums.tracks[0];
        assert!(t.active && t.rows[0].sample.is_none() && t.rows[0].steps[0] == 0);
        assert_eq!(t.rows[0].pan, 0.0);
        assert_eq!(t.step_count, 16);
    }

    #[test]
    fn add_within_tail_does_not_cut() {
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 1280);
        e.command(OP_REMOVE_TRACK, 0.0, 0.0, 0.0, 0.0);
        let mut l = [0.0f32; 40];
        let mut r = [0.0f32; 40];
        e.process(&mut l, &mut r); // 40 samples into the 96-sample tail
        let before = l[39];
        e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0); // remove-then-add
        let (l2, _) = render2(&mut e, 256);
        assert!(l2[0] > 0.0 && l2[0] <= before, "tail continues");
        assert!(l2.windows(2).all(|w| w[1] <= w[0] && w[0] - w[1] <= 0.1));
        assert!(l2[60..].iter().all(|&x| x == 0.0));
        assert!(l2[50] > 0.0);
    }

    #[test]
    fn replaced_sample_mid_play_stops_safely() {
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 1280);
        e.sample_alloc(0, 5, 1).unwrap(); // un-ready replacement
        let (l, _) = render2(&mut e, 1280);
        let v: f32 = 0.5f32.sqrt() * 0.8;
        // holds the last value and decays monotonically within 96 samples
        assert!((l[0] - v).abs() < 0.01, "{}", l[0]);
        assert!(l.windows(2).all(|w| w[1] <= w[0] && w[0] - w[1] <= 0.1));
        assert!(l[96..].iter().all(|&x| x == 0.0));
        assert!(l[90] > 0.0);

        // re-allocated AND re-readied between blocks: must not read the new data
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        render2(&mut e, 1280);
        load_const(&mut e, 0, 48000, -1.0);
        let (l, _) = render2(&mut e, 1280);
        assert!(l.iter().all(|&x| x >= 0.0), "never plays the new sample's data");
        assert!(l.windows(2).all(|w| w[1] <= w[0]));
        assert!(l[96..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn sample_alloc_rejects_huge() {
        let mut e = Engine::new(SR);
        let max = 64 * 1024 * 1024u32;
        assert_eq!(e.sample_alloc(0, max + 1, 1), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.sample_alloc(0, max / 2 + 1, 2), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.sample_alloc(0, u32::MAX, 2), Err(protocol::ERR_BAD_VALUE));
        assert_eq!(e.telemetry()[7], protocol::ERR_BAD_VALUE as f64);
    }

    // ---- synth tracks -----------------------------------------------------

    use crate::protocol::{
        ERR_BAD_INDEX, ERR_BAD_VALUE, OK, OP_ADD_SYNTH_TRACK, OP_MOD_WHEEL, OP_PITCH_BEND,
        OP_RACK_ADD_MODULE, OP_RACK_CLEAR, OP_RACK_CONNECT, OP_RACK_DISCONNECT,
        OP_RACK_REMOVE_MODULE, OP_RACK_SET_PARAM, OP_SET_INPUT_TRACK, OP_SUSTAIN,
    };

    // Module kind wire ids (catalog.rs).
    const K_MIDI_IN: f64 = 0.0;
    const K_OSC: f64 = 1.0;
    const K_ADSR: f64 = 4.0;
    const K_VCA: f64 = 5.0;
    const K_OUT: f64 = 8.0;
    const K_LFO: f64 = 6.0;
    // Module slots used by `synth_patch`.
    const M_MIDI: usize = 0;
    const M_OSC: usize = 1;
    const M_ADSR: usize = 2;
    const M_VCA: usize = 3;
    const M_OUT: usize = 4;
    /// ADSR release used by `synth_patch` (s).
    const RELEASE: f64 = 0.1;

    /// Packed port argument: `module * 16 + port`.
    fn pk(module: usize, port: usize) -> f64 {
        (module * 16 + port) as f64
    }

    /// Synth track at `slot`: MIDI In -> Osc (sine) -> VCA <- ADSR -> Out.l,
    /// ADSR release `RELEASE`.
    fn synth_patch(e: &mut Engine, slot: f64) {
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, slot, 0.0, 0.0, 0.0), OK);
        for (m, kind) in [(M_MIDI, K_MIDI_IN), (M_OSC, K_OSC), (M_ADSR, K_ADSR), (M_VCA, K_VCA), (M_OUT, K_OUT)] {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, slot, m as f64, kind, 0.0), OK);
        }
        for (from, to) in [
            ((M_MIDI, 0), (M_OSC, 0)),  // pitch -> osc pitch
            ((M_MIDI, 1), (M_ADSR, 0)), // gate -> adsr gate
            ((M_OSC, 0), (M_VCA, 0)),   // osc -> vca in
            ((M_ADSR, 0), (M_VCA, 1)),  // env -> vca cv
            ((M_VCA, 0), (M_OUT, 0)),   // vca -> out l (r unconnected = l)
        ] {
            assert_eq!(e.command(OP_RACK_CONNECT, slot, pk(from.0, from.1), pk(to.0, to.1), 0.0), OK);
        }
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, M_OSC as f64, 0.0, 3.0), OK); // sine
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, M_ADSR as f64, 3.0, RELEASE), OK);
    }

    fn peak(s: &[f32]) -> f32 {
        s.iter().fold(0.0f32, |m, x| m.max(x.abs()))
    }

    fn max_jump(prev: f32, xs: &[f32]) -> f32 {
        let mut last = prev;
        let mut m = 0.0f32;
        for &x in xs {
            m = m.max((x - last).abs());
            last = x;
        }
        m
    }

    #[test]
    fn synth_track_plays_live_notes() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        assert_eq!(e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0), OK);
        let s = render(&mut e, 24000); // 0.5 s
        assert!(peak(&s) > 0.1, "peak {}", peak(&s));
        // A4: 440 Hz from the rising zero crossings (after the attack).
        let ups: Vec<usize> = (480..s.len()).filter(|&i| s[i - 1] < 0.0 && s[i] >= 0.0).collect();
        let hz = (ups.len() - 1) as f32 * SR / (ups[ups.len() - 1] - ups[0]) as f32;
        assert!((hz - 440.0).abs() < 2.0, "freq {hz}");
        assert!(s.windows(2).all(|w| (w[1] - w[0]).abs() <= 0.05), "no clicks");
        assert_eq!(e.command(OP_NOTE_OFF, 69.0, 0.0, 0.0, 0.0), OK);
        let frames = ((RELEASE + 0.05) * SR as f64) as usize;
        let s = render(&mut e, frames.div_ceil(128) * 128);
        assert!(s[0].abs() > 0.0, "release is not a hard cut");
        // Silence: below -60 dBFS (the release is exponential, 1% at RELEASE).
        assert!(peak(&s[s.len() - 128..]) < 1e-3, "tail {}", peak(&s[s.len() - 128..]));
    }

    #[test]
    fn velocity_zero_note_on_releases_synth_note() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 0.0);
        e.command(OP_SET_INPUT_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 60.0, 100.0, 0.0, 0.0);
        render(&mut e, 4800);
        e.command(OP_NOTE_ON, 60.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 128 * 60);
        assert!(peak(&s[s.len() - 128..]) < 1e-3);
    }

    #[test]
    fn set_input_track_releases_old_notes() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        synth_patch(&mut e, 4.0);
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 60.0, 127.0, 0.0, 0.0);
        assert!(peak(&render(&mut e, 4800)) > 0.1);
        // Switch while the note is held: track 3 gets AllOff and releases.
        assert_eq!(e.command(OP_SET_INPUT_TRACK, 4.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 128 * 60); // 160 ms
        assert!(peak(&s[s.len() - 128..]) < 1e-3, "track 3 still sounding");
        // The NOTE_OFF now goes to track 4 (nothing held there): harmless.
        assert_eq!(e.command(OP_NOTE_OFF, 60.0, 0.0, 0.0, 0.0), OK);
        // New notes reach track 4.
        e.command(OP_NOTE_ON, 64.0, 127.0, 0.0, 0.0);
        assert!(peak(&render(&mut e, 4800)) > 0.1);
    }

    #[test]
    fn input_track_is_not_inherited_by_a_new_track() {
        // REMOVE_TRACK on the input slot unsets the input track.
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        assert_eq!(e.command(OP_REMOVE_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        render(&mut e, 1280);
        synth_patch(&mut e, 3.0);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        assert!(render(&mut e, 4800).iter().all(|&x| x == 0.0), "input inherited after remove");
        // So does replacing the synth with a drum track.
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        assert_eq!(e.command(OP_ADD_DRUM_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        render(&mut e, 1280);
        synth_patch(&mut e, 3.0);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        assert!(render(&mut e, 4800).iter().all(|&x| x == 0.0), "input inherited after kind swap");
    }

    #[test]
    fn controllers_follow_an_input_switch() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        synth_patch(&mut e, 4.0);
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        assert_eq!(e.command(OP_SUSTAIN, 1.0, 0.0, 0.0, 0.0), OK);
        e.command(OP_NOTE_ON, 60.0, 127.0, 0.0, 0.0);
        render(&mut e, 4800);
        e.command(OP_NOTE_OFF, 60.0, 0.0, 0.0, 0.0); // held by the pedal
        assert!(peak(&render(&mut e, 4800)) > 0.1, "sustained on track 3");
        // Switch: track 3 gets AllOff + pedal up, and releases.
        e.command(OP_SET_INPUT_TRACK, 4.0, 0.0, 0.0, 0.0);
        let frames = ((RELEASE + 0.05) * SR as f64) as usize;
        let s = render(&mut e, frames.div_ceil(128) * 128);
        assert!(peak(&s[s.len() - 128..]) < 1e-3, "track 3 still sounding");
        // Track 4 got the pedal (still down): a released note keeps sounding.
        e.command(OP_NOTE_ON, 64.0, 127.0, 0.0, 0.0);
        render(&mut e, 4800);
        e.command(OP_NOTE_OFF, 64.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 128 * 75); // 200 ms, past release + 50 ms
        assert!(peak(&s[s.len() - 128..]) > 0.1, "pedal not replayed to track 4");
        // Pedal up releases it.
        e.command(OP_SUSTAIN, 0.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, frames.div_ceil(128) * 128);
        assert!(peak(&s[s.len() - 128..]) < 1e-3);
    }

    #[test]
    fn notes_without_input_track_are_ignored() {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        // No input track yet.
        assert_eq!(e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_PITCH_BEND, 0.5, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_MOD_WHEEL, 0.5, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_SUSTAIN, 1.0, 0.0, 0.0, 0.0), OK);
        assert!(render(&mut e, 4800).iter().all(|&x| x == 0.0));
        // Set, then unset (-1): ignored again.
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        assert_eq!(e.command(OP_SET_INPUT_TRACK, -1.0, 0.0, 0.0, 0.0), OK);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        assert!(render(&mut e, 4800).iter().all(|&x| x == 0.0));
        // An input track that is a drum (or empty) slot plays nothing.
        e.command(OP_ADD_DRUM_TRACK, 5.0, 0.0, 0.0, 0.0);
        assert_eq!(e.command(OP_SET_INPUT_TRACK, 5.0, 0.0, 0.0, 0.0), OK);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        assert_eq!(e.command(OP_SET_INPUT_TRACK, 9.0, 0.0, 0.0, 0.0), OK);
        e.command(OP_NOTE_ON, 70.0, 127.0, 0.0, 0.0);
        assert!(render(&mut e, 4800).iter().all(|&x| x == 0.0));
    }

    #[test]
    fn rack_commands_validate() {
        let mut e = Engine::new(SR);
        e.command(OP_ADD_DRUM_TRACK, 0.0, 0.0, 0.0, 0.0);
        // Rack commands on a drum slot or an empty slot.
        for slot in [0.0, 7.0] {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, slot, 0.0, K_OSC, 0.0), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_RACK_REMOVE_MODULE, slot, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_RACK_CONNECT, slot, pk(0, 0), pk(1, 0), 0.0), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_RACK_DISCONNECT, slot, pk(1, 0), 0.0, 0.0), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_RACK_SET_PARAM, slot, 0.0, 0.0, 0.5), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_RACK_CLEAR, slot, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
        }
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, 1.0, 0.0, 0.0, 0.0), OK);
        // Drum commands on a synth slot.
        assert_eq!(e.command(OP_SET_STEP, 1.0, 0.0, 0.0, 100.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_ROW_SAMPLE, 1.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_ROW_GAIN, 1.0, 0.0, 1.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_ROW_PAN, 1.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_ROW_MUTE, 1.0, 0.0, 1.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_STEP_COUNT, 1.0, 32.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_SET_SWING, 1.0, 0.5, 0.0, 0.0), ERR_BAD_INDEX);
        // Bad kind ids / module indices / slots.
        for kind in [99.0, 9.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 1e300] {
            assert_eq!(e.command(OP_RACK_ADD_MODULE, 1.0, 0.0, kind, 0.0), ERR_BAD_INDEX, "kind {kind}");
        }
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 1.0, 32.0, K_OSC, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 32.0, 0.0, K_OSC, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 1.0, 0.0, K_OSC, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 1.0, 1.0, K_VCA, 0.0), OK);
        // Rack error codes propagate (occupied slot is the rack's ERR_BAD_VALUE)
        // and land in LAST_ERROR.
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 1.0, 0.0, K_LFO, 0.0), ERR_BAD_VALUE);
        assert_eq!(e.telemetry()[TELEMETRY_LAST_ERROR], ERR_BAD_VALUE as f64);
        // Ports: port index >= MAX_PORTS, module >= MAX_MODULES, garbage packing.
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 8), pk(1, 0), 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 15), pk(1, 0), 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 0), pk(32, 0), 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, 0.5, pk(1, 0), 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, -1.0, pk(1, 0), 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 1), pk(1, 0), 0.0), ERR_BAD_INDEX, "osc has 1 output");
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 0), pk(5, 0), 0.0), ERR_BAD_INDEX, "no module 5");
        assert_eq!(e.command(OP_RACK_DISCONNECT, 1.0, pk(1, 9), 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_DISCONNECT, 1.0, f64::NAN, 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_CONNECT, 1.0, pk(0, 0), pk(1, 0), 0.0), OK);
        assert_eq!(e.command(OP_RACK_DISCONNECT, 1.0, pk(1, 0), 0.0, 0.0), OK);
        // Params.
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 0.0, 1.5), ERR_BAD_VALUE, "vca level 0..1");
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 0.0, f64::NAN), ERR_BAD_VALUE);
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 0.0, 1e300), ERR_BAD_VALUE);
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 1.0, 0.5), ERR_BAD_INDEX, "vca has 1 param");
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 12.0, 0.5), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 9.0, 0.0, 0.5), ERR_BAD_INDEX, "empty module");
        assert_eq!(e.command(OP_RACK_SET_PARAM, 1.0, 1.0, 0.0, 0.5), OK);
        assert_eq!(e.command(OP_RACK_REMOVE_MODULE, 1.0, 9.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_REMOVE_MODULE, 1.0, 1.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_RACK_CLEAR, 1.0, 0.0, 0.0, 0.0), OK);
        // Input track and controllers.
        for bad in [-2.0, 32.0, 0.5, f64::NAN] {
            assert_eq!(e.command(OP_SET_INPUT_TRACK, bad, 0.0, 0.0, 0.0), ERR_BAD_INDEX, "slot {bad}");
        }
        assert_eq!(e.command(OP_PITCH_BEND, 1.5, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
        assert_eq!(e.command(OP_PITCH_BEND, f64::NAN, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
        assert_eq!(e.command(OP_MOD_WHEEL, -0.1, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
        assert_eq!(e.command(OP_SUSTAIN, 2.0, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
        // Garbage on every new op never panics, and audio keeps rendering.
        let vals = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1e300, 1e300, 0.5, -0.0, 3e9, -1.0, 1.0, 17.0];
        for op in 17..=27u32 {
            for &v in &vals {
                for &w in &vals {
                    let _ = e.command(op, 1.0, v, w, v);
                    let _ = e.command(op, v, w, v, w);
                }
            }
        }
        assert!(render(&mut e, 1280).iter().all(|x| x.is_finite()));
    }

    /// Held sine note at slot 3; returns the engine and the last sample.
    fn sounding_synth() -> (Engine, f32) {
        let mut e = Engine::new(SR);
        synth_patch(&mut e, 3.0);
        e.command(OP_SET_INPUT_TRACK, 3.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        let s = render(&mut e, 4800);
        assert!(peak(&s[s.len() - 128..]) > 0.1);
        (e, s[s.len() - 1])
    }

    #[test]
    fn remove_synth_track_fades() {
        let (mut e, last) = sounding_synth();
        assert_eq!(e.command(OP_REMOVE_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 1280);
        let j = max_jump(last, &s);
        assert!(j <= 0.05, "jump {j}");
        assert!(s[(0.004 * SR) as usize..].iter().all(|&x| x == 0.0), "silent after the fade");
        // The slot is empty now: rack commands fail, notes do nothing.
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 3.0, 9.0, K_OSC, 0.0), ERR_BAD_INDEX);
        e.command(OP_NOTE_ON, 72.0, 127.0, 0.0, 0.0);
        assert!(render(&mut e, 1280).iter().all(|&x| x == 0.0));
        // Re-adding gives an empty patch (module slot 0 is free again).
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 3.0, 0.0, K_OSC, 0.0), OK);
    }

    #[test]
    fn re_adding_a_sounding_synth_track_fades_to_an_empty_patch() {
        let (mut e, last) = sounding_synth();
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        // Validation sees the empty patch at once.
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 3.0, 0.0, K_OSC, 0.0), OK);
        let s = render(&mut e, 1280);
        assert!(max_jump(last, &s) <= 0.05);
        assert!(s[(0.004 * SR) as usize..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn slot_kind_swap_fades_both_ways() {
        // Synth -> drum: the synth fades out, the slot takes drum commands.
        let (mut e, last) = sounding_synth();
        assert_eq!(e.command(OP_ADD_DRUM_TRACK, 3.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 1280);
        assert!(max_jump(last, &s) <= 0.05, "synth -> drum jump");
        assert!(s[(0.004 * SR) as usize..].iter().all(|&x| x == 0.0));
        assert_eq!(e.command(OP_SET_STEP, 3.0, 0.0, 0.0, 100.0), OK);
        assert_eq!(e.command(OP_RACK_CLEAR, 3.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);

        // Drum -> synth: the sounding drum voice fades out (no hard cut).
        let mut e = Engine::new(SR);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 2.0, 0.0, &[0.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 1280);
        let last = s[s.len() - 1];
        assert!(last > 0.5);
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, 2.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 1280);
        assert!(s[0] > 0.0 && s[0] <= last, "drum tail continues");
        assert!(s.windows(2).all(|w| w[1] <= w[0] && w[0] - w[1] <= 0.1));
        assert!(s[96..].iter().all(|&x| x == 0.0));
        assert_eq!(e.command(OP_SET_STEP, 2.0, 0.0, 0.0, 100.0), ERR_BAD_INDEX);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, 2.0, 0.0, K_OSC, 0.0), OK);
    }

    #[test]
    fn synth_ctx_follows_transport() {
        // A synced LFO (1/4 note, square) straight into Out: while playing at
        // 120 bpm it is locked to the playhead (2 Hz, high for the first
        // half of each beat).
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_RACK_ADD_MODULE, 0.0, 0.0, K_LFO, 0.0);
        e.command(OP_RACK_ADD_MODULE, 0.0, 1.0, K_OUT, 0.0);
        assert_eq!(e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 0.0, 3.0), OK); // square
        assert_eq!(e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 2.0, 1.0), OK); // sync
        assert_eq!(e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 3.0, 3.0), OK); // 1/4
        assert_eq!(e.command(OP_RACK_CONNECT, 0.0, pk(0, 0), pk(1, 0), 0.0), OK);
        // Stopped: it still renders (free-running at the division's rate).
        assert!(peak(&render(&mut e, 4800)) > 0.1);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 48000);
        // Beat = 24000 frames: high in [0, 12000), low in [12000, 24000).
        for (at, sign) in [(6000usize, 1.0f32), (18000, -1.0), (30000, 1.0), (42000, -1.0)] {
            assert!(s[at] * sign > 0.5, "at {at}: {}", s[at]);
        }
    }

    #[test]
    fn sample_alloc_defers_when_full_and_playing() {
        let mut e = Engine::new(SR);
        assert!(e.arena.alloc(ARENA_FLOATS, false).is_some()); // bumps offset only
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        assert_eq!(e.sample_alloc(0, 10, 1), Err(protocol::ERR_DEFERRED));
        assert_eq!(e.telemetry()[7], protocol::ERR_DEFERRED as f64);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        assert!(e.sample_alloc(0, 10, 1).is_ok());
    }

    // ---- note patterns and count-in ----------------------------------------

    use crate::protocol::{OP_NOTE_CLEAR, OP_NOTE_REMOVE, OP_NOTE_SET, OP_SET_PATTERN_BARS};
    use crate::MAX_NOTES;

    /// Set note `idx` of track `slot` (velocity 100); asserts OK.
    fn set_note(e: &mut Engine, slot: usize, idx: usize, pitch: u32, start: u32, len: u32) {
        let a = (slot * MAX_NOTES + idx) as f64;
        assert_eq!(e.command(OP_NOTE_SET, a, (pitch * 128 + 100) as f64, start as f64, len as f64), OK);
    }

    /// Synth track at `slot`: MIDI In gate -> Out.l at `level`, so the output
    /// is exactly `held voices * level * 0.8 (master)` while gates are high and
    /// exactly 0 otherwise.
    fn gate_patch(e: &mut Engine, slot: f64, level: f64) {
        assert_eq!(e.command(OP_ADD_SYNTH_TRACK, slot, 0.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, slot, 0.0, K_MIDI_IN, 0.0), OK);
        assert_eq!(e.command(OP_RACK_ADD_MODULE, slot, 1.0, K_OUT, 0.0), OK);
        assert_eq!(e.command(OP_RACK_CONNECT, slot, pk(0, 1), pk(1, 0), 0.0), OK);
        assert_eq!(e.command(OP_RACK_SET_PARAM, slot, 1.0, 0.0, level), OK);
    }

    /// Render `frames` in blocks of `block` frames (left channel).
    fn render_blocks(e: &mut Engine, frames: usize, block: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let (mut l, mut r) = (vec![0.0f32; block], vec![0.0f32; block]);
        for _ in 0..frames / block {
            e.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        out
    }

    /// Indices where the output goes from exactly 0 to non-zero.
    fn rising(s: &[f32]) -> Vec<usize> {
        (0..s.len()).filter(|&i| s[i] != 0.0 && (i == 0 || s[i - 1] == 0.0)).collect()
    }

    /// Indices where the output goes from non-zero to exactly 0.
    fn falling(s: &[f32]) -> Vec<usize> {
        (1..s.len()).filter(|&i| s[i] == 0.0 && s[i - 1] != 0.0).collect()
    }

    fn near(got: usize, want: usize, tol: usize) -> bool {
        got >= want && got <= want + tol
    }

    fn play(e: &mut Engine, count_in: f64) {
        assert_eq!(e.command(OP_PLAY, count_in, 0.0, 0.0, 0.0), OK);
    }

    #[test]
    fn note_on_off_at_exact_offsets() {
        // A note at 960 (sample 24000) for 480 ticks (off at 36000) through
        // MIDI In -> Osc -> VCA <- ADSR -> Out, 128-frame blocks.
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        synth_patch(&mut e, 0.0);
        set_note(&mut e, 0, 0, 69, 960, 480);
        play(&mut e, 0.0);
        let s = render(&mut e, 48000);
        assert!(s[..24000].iter().all(|&x| x == 0.0), "silent before the note");
        assert!(s[24000..24032].iter().any(|&x| x != 0.0), "sounds within 32 frames of 24000");
        // Reference: the same note played live, with 32-frame blocks so the
        // events land exactly at 24000 and 36000. Identical output proves the
        // On *and* the release start at those samples (one sub-block grid).
        let mut r = Engine::new(SR);
        synth_patch(&mut r, 0.0);
        r.command(OP_SET_INPUT_TRACK, 0.0, 0.0, 0.0, 0.0);
        let mut want = render_blocks(&mut r, 24000, 32);
        r.command(OP_NOTE_ON, 69.0, 100.0, 0.0, 0.0);
        want.extend(render_blocks(&mut r, 12000, 32));
        r.command(OP_NOTE_OFF, 69.0, 0.0, 0.0, 0.0);
        want.extend(render_blocks(&mut r, 12000, 32));
        assert!(peak(&want[30000..36000]) > 0.1);
        for i in 0..48000 {
            assert!((s[i] - want[i]).abs() < 1e-6, "sample {i}: {} vs {}", s[i], want[i]);
        }
    }

    #[test]
    fn notes_loop_on_pattern_length() {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        gate_patch(&mut e, 0.0, 0.25);
        assert_eq!(e.command(OP_SET_PATTERN_BARS, 0.0, 1.0, 0.0, 0.0), OK);
        set_note(&mut e, 0, 0, 60, 0, 480);
        play(&mut e, 0.0);
        let s = render(&mut e, 96000 + 12800);
        let on = rising(&s);
        assert_eq!(on.len(), 2, "{on:?}");
        assert!(near(on[0], 0, 32) && near(on[1], 96000, 32), "{on:?}");
        assert!(near(falling(&s)[0], 12000, 32));
    }

    #[test]
    fn note_crossing_loop_end_releases_after_wrap() {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        gate_patch(&mut e, 0.0, 0.25);
        e.command(OP_SET_PATTERN_BARS, 0.0, 1.0, 0.0, 0.0);
        set_note(&mut e, 0, 0, 60, 3360, 960); // 84000 .. 96000 + 12000
        play(&mut e, 0.0);
        let s = render(&mut e, 128 * 1000);
        let (on, off) = (rising(&s), falling(&s));
        assert_eq!(on.len(), 1, "{on:?}");
        assert!(near(on[0], 84000, 32), "{on:?}");
        assert_eq!(off.len(), 1, "{off:?}");
        assert!(near(off[0], 108000, 32), "off at tick 480 of the next loop: {off:?}");
    }

    #[test]
    fn removing_a_sounding_note_releases_it() {
        let mut e = Engine::new(SR);
        gate_patch(&mut e, 0.0, 0.25);
        set_note(&mut e, 0, 7, 60, 0, 3840);
        play(&mut e, 0.0);
        assert!(render(&mut e, 12800)[12799] > 0.1);
        assert_eq!(e.command(OP_NOTE_REMOVE, 7.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 12800);
        assert!(s[32..].iter().all(|&x| x == 0.0), "released within one sub-block");
        // Moving a sounding note releases it too (it plays again from its new start).
        set_note(&mut e, 0, 3, 64, 0, 3840);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        play(&mut e, 0.0);
        assert!(render(&mut e, 12800)[12799] > 0.1);
        set_note(&mut e, 0, 3, 64, 2000, 3840); // playhead at 512..1024: not yet
        assert!(render(&mut e, 12800)[32..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn shortening_pattern_releases_and_mutes_notes_beyond_end() {
        // 4 bars at 120 bpm: a bar is 96000 samples. A note in bar 3.
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        gate_patch(&mut e, 0.0, 0.25);
        set_note(&mut e, 0, 0, 60, 7680, 1920);
        play(&mut e, 0.0);
        let s = render(&mut e, 128 * 1519); // 194432: inside the note
        assert!(s[..192000].iter().all(|&x| x == 0.0));
        assert!(s[194431] > 0.1, "sounding in bar 3");
        assert_eq!(e.command(OP_SET_PATTERN_BARS, 0.0, 2.0, 0.0, 0.0), OK);
        let s = render(&mut e, 2 * 192000);
        assert!(s[32..].iter().all(|&x| x == 0.0), "released, then silent for two 2-bar loops");
        assert_eq!(e.command(OP_SET_PATTERN_BARS, 0.0, 4.0, 0.0, 0.0), OK);
        let s = render(&mut e, 384000);
        assert!(peak(&s) > 0.1, "plays again at 4 bars");
    }

    #[test]
    fn stop_releases_sequenced_but_not_live_notes() {
        let mut e = Engine::new(SR);
        gate_patch(&mut e, 0.0, 0.25);
        e.command(OP_SET_INPUT_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 72.0, 127.0, 0.0, 0.0); // live key, held
        set_note(&mut e, 0, 0, 60, 0, 3840);
        play(&mut e, 0.0);
        let s = render(&mut e, 4864);
        assert!((s[4863] - 0.4).abs() < 1e-3, "two gates: {}", s[4863]);
        assert_eq!(e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0), OK);
        let s = render(&mut e, 4864);
        assert!(s[32..].iter().all(|&x| (x - 0.2).abs() < 1e-3), "live key still held: {}", s[4863]);
        assert_eq!(e.command(OP_NOTE_OFF, 72.0, 0.0, 0.0, 0.0), OK);
        assert!(render(&mut e, 1280)[32..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn two_tracks_loop_independently() {
        // Track 0: 1 bar, 0.2 per gate; track 1: 2 bars, 0.4 per gate.
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        gate_patch(&mut e, 0.0, 0.25);
        gate_patch(&mut e, 1.0, 0.5);
        e.command(OP_SET_PATTERN_BARS, 0.0, 1.0, 0.0, 0.0);
        e.command(OP_SET_PATTERN_BARS, 1.0, 2.0, 0.0, 0.0);
        set_note(&mut e, 0, 0, 60, 0, 480);
        set_note(&mut e, 1, 0, 60, 0, 480);
        play(&mut e, 0.0);
        let s = render(&mut e, 192000 + 3200);
        for (at, want) in [(2000usize, 0.6f32), (50000, 0.0), (98000, 0.2), (146000, 0.0), (194000, 0.6)] {
            assert!((s[at] - want).abs() < 1e-3, "at {at}: {} vs {want}", s[at]);
        }
    }

    #[test]
    fn count_in_clicks_and_delays_patterns() {
        // 120 bpm, metronome OFF, one-bar count-in: clicks at 0/0.5/1/1.5 s,
        // then the drum hit and the pattern note at 96000 (tick 0).
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        load_const(&mut e, 0, 10, 1.0);
        drum_setup(&mut e, 1.0, 0.0, &[0.0]);
        gate_patch(&mut e, 0.0, 0.25);
        set_note(&mut e, 0, 0, 60, 0, 480);
        play(&mut e, 3840.0);
        let s = render(&mut e, 128);
        assert!((e.telemetry()[TELEMETRY_TICKS] - (-3840.0 + 128.0 / 25.0)).abs() < 1e-9, "playhead starts at -1 bar");
        let mut s = s;
        s.extend(render(&mut e, 96000 + 3200 - 128));
        let on = onsets(&s[..96000]);
        assert_eq!(on.len(), 4, "{on:?}");
        for (got, want) in on.iter().zip([0usize, 24000, 48000, 72000]) {
            assert!(near(*got, want, 1), "{got} vs {want}");
        }
        let c0 = upward_crossings(&s[on[0]..on[0] + 960]);
        let c1 = upward_crossings(&s[on[1]..on[1] + 960]);
        assert!((29..=30).contains(&c0), "count-in bar starts with the accent ({c0})");
        assert!((19..=20).contains(&c1), "{c1}");
        // Nothing but the clicks before 96000: no drum, no note.
        for (i, &x) in s[..96000].iter().enumerate() {
            let in_click = on.iter().any(|&o| i + 1 >= o && i < o + 960);
            assert!(in_click || x == 0.0, "sample {i}: {x}");
        }
        assert_eq!(s[95999], 0.0);
        assert!(s[96000] > 0.5, "drum hit at exactly tick 0: {}", s[96000]);
        assert!(s[96032..96100].iter().all(|&x| (x - 0.2).abs() < 1e-3), "note on within 32 frames");
        // No click at tick 0 (metronome off): the drum's 10 frames, then only the gate.
        assert!(s[96010..96032].iter().all(|&x| x == 0.0 || (x - 0.2).abs() < 1e-3));
    }

    #[test]
    fn metronome_on_keeps_clicking_through_count_in() {
        let mut e = start_metronome(120.0);
        e.command(OP_STOP, 0.0, 0.0, 0.0, 0.0);
        play(&mut e, 3840.0);
        let s = render(&mut e, 96000 * 2);
        let on = onsets(&s);
        assert_eq!(on.len(), 8, "{on:?}");
        let c4 = upward_crossings(&s[on[4]..on[4] + 960]);
        assert!((29..=30).contains(&c4), "bar 1 accent after the count-in ({c4})");
        assert!(near(on[4], 96000, 1));
    }

    #[test]
    fn play_while_playing_ignores_count_in() {
        let mut e = Engine::new(SR);
        play(&mut e, 0.0);
        render(&mut e, 1280);
        let t = e.telemetry()[TELEMETRY_TICKS];
        play(&mut e, 3840.0);
        render(&mut e, 128);
        assert!(e.telemetry()[TELEMETRY_TICKS] > t);
    }

    #[test]
    fn synced_lfo_runs_through_count_in() {
        // Same patch as synth_ctx_follows_transport: square, synced to 1/4.
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        e.command(OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0);
        e.command(OP_RACK_ADD_MODULE, 0.0, 0.0, K_LFO, 0.0);
        e.command(OP_RACK_ADD_MODULE, 0.0, 1.0, K_OUT, 0.0);
        e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 0.0, 3.0);
        e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 2.0, 1.0);
        e.command(OP_RACK_SET_PARAM, 0.0, 0.0, 3.0, 3.0);
        e.command(OP_RACK_CONNECT, 0.0, pk(0, 0), pk(1, 0), 0.0);
        play(&mut e, 3840.0);
        let s = render(&mut e, 96000 * 2);
        // Locked to beats during the count-in (negative ticks) and after it.
        for k in 0..8usize {
            let b = k * 24000;
            assert!(s[b + 6000] > 0.5 && s[b + 18000] < -0.5, "beat {k}: {} {}", s[b + 6000], s[b + 18000]);
        }
    }

    #[test]
    fn note_commands_validate() {
        let mut e = Engine::new(SR);
        e.command(OP_ADD_DRUM_TRACK, 1.0, 0.0, 0.0, 0.0);
        gate_patch(&mut e, 2.0, 0.25);
        let a = |slot: usize, idx: usize| (slot * MAX_NOTES + idx) as f64;
        let pv = |pitch: f64, vel: f64| pitch * 128.0 + vel;
        // Bad, drum and empty slots.
        for bad in [a(32, 0), -1.0, 0.5, f64::NAN, a(1, 0), a(5, 3)] {
            assert_eq!(e.command(OP_NOTE_SET, bad, pv(60.0, 100.0), 0.0, 10.0), ERR_BAD_INDEX, "a {bad}");
            assert_eq!(e.command(OP_NOTE_REMOVE, bad, 0.0, 0.0, 0.0), ERR_BAD_INDEX, "a {bad}");
        }
        for slot in [1.0, 5.0, 32.0, f64::NAN] {
            assert_eq!(e.command(OP_NOTE_CLEAR, slot, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
            assert_eq!(e.command(OP_SET_PATTERN_BARS, slot, 2.0, 0.0, 0.0), ERR_BAD_INDEX);
        }
        // Values.
        for (b, c, d) in [
            (pv(128.0, 100.0), 0.0, 10.0),
            (pv(60.0, 0.0), 0.0, 10.0),
            (pv(60.0, 100.0), 0.0, 0.0),
            (pv(60.0, 100.0), 61440.0, 10.0),
            (pv(60.0, 100.0) + 0.5, 0.0, 10.0),
            (pv(60.0, 100.0), 0.5, 10.0),
            (pv(60.0, 100.0), 0.0, 10.5),
            (f64::NAN, 0.0, 10.0),
            (pv(60.0, 100.0), f64::NAN, 10.0),
            (pv(60.0, 100.0), 0.0, f64::INFINITY),
        ] {
            assert_eq!(e.command(OP_NOTE_SET, a(2, 0), b, c, d), ERR_BAD_VALUE, "{b} {c} {d}");
        }
        for bars in [0.0, 17.0, 2.5, f64::NAN] {
            assert_eq!(e.command(OP_SET_PATTERN_BARS, 2.0, bars, 0.0, 0.0), ERR_BAD_VALUE);
        }
        assert_eq!(e.command(OP_PLAY, 1.0, 0.0, 0.0, 0.0), ERR_BAD_VALUE);
        assert_eq!(e.telemetry()[TELEMETRY_LAST_ERROR], ERR_BAD_VALUE as f64);
        // Valid edges.
        assert_eq!(e.command(OP_NOTE_SET, a(2, MAX_NOTES - 1), pv(127.0, 127.0), 61439.0, 61440.0), OK);
        assert_eq!(e.command(OP_NOTE_SET, a(2, 0), pv(0.0, 1.0), 0.0, 1.0), OK);
        assert_eq!(e.command(OP_NOTE_REMOVE, a(2, 5), 0.0, 0.0, 0.0), OK, "removing an empty slot is fine");
        assert_eq!(e.command(OP_SET_PATTERN_BARS, 2.0, 16.0, 0.0, 0.0), OK);
        assert_eq!(e.command(OP_NOTE_CLEAR, 2.0, 0.0, 0.0, 0.0), OK);
        // Garbage on the new ops never panics, and audio keeps rendering.
        play(&mut e, 0.0);
        let vals = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1e300, 1e300, 0.5, -0.0, 3e9, -1.0, 1.0, 2049.0];
        for op in 28..=31u32 {
            for &v in &vals {
                for &w in &vals {
                    let _ = e.command(op, a(2, 1), v, w, v);
                    let _ = e.command(op, v, w, v, w);
                }
            }
        }
        assert!(render(&mut e, 12800).iter().all(|x| x.is_finite()));
    }

    #[test]
    fn re_adding_a_synth_track_resets_its_pattern() {
        let mut e = Engine::new(SR);
        gate_patch(&mut e, 0.0, 0.25);
        set_note(&mut e, 0, 0, 60, 0, 3840);
        e.command(OP_SET_PATTERN_BARS, 0.0, 1.0, 0.0, 0.0);
        gate_patch(&mut e, 0.0, 0.25); // fresh track: empty pattern, 4 bars
        play(&mut e, 0.0);
        assert!(render(&mut e, 12800).iter().all(|&x| x == 0.0));
        assert_eq!(e.synths.pattern(0).map(|p| p.bars()), Some(4));
    }
}
