//! Engine core: owns all state, decodes commands, renders blocks.
//! `process` is the real-time callback: no allocation, no blocking, no panics.

use crate::arena::SampleArena;
use crate::drums::Drums;
use crate::protocol::{self, Command};
use crate::samples::{Sample, SamplePool};
use crate::metronome::Metronome;
use crate::test_tone::TestTone;
use crate::transport::{events_in_window, tick_to_offset, Transport};
use crate::{MAX_BLOCK, MAX_SAMPLES, PPQ};

/// 4/4: a bar is 4 beats; beat 0 of each bar is the accent.
const BAR_TICKS: f64 = 4.0 * PPQ;
const BEAT_OFFSETS: [f64; 4] = [0.0, PPQ, 2.0 * PPQ, 3.0 * PPQ];

/// Initial arena size in floats (128 MB).
const ARENA_FLOATS: usize = 32 * 1024 * 1024;

/// Per-sample size cap in floats (256 MB).
const MAX_SAMPLE_FLOATS: usize = 64 * 1024 * 1024;

pub struct Engine {
    tone: TestTone,
    master_gain: f32,
    sample_rate: f32,
    transport: Transport,
    metronome: Metronome,
    telemetry: [f64; 8],
    arena: SampleArena,
    samples: SamplePool,
    drums: Drums,
}

impl Engine {
    /// Does all big allocations: reserves the 32 Mi-float (128 MB) sample arena.
    pub fn new(sample_rate: f32) -> Engine {
        Engine {
            tone: TestTone::new(sample_rate),
            master_gain: 0.8,
            sample_rate,
            transport: Transport::new(),
            metronome: Metronome::new(sample_rate),
            telemetry: [0.0; 8],
            arena: SampleArena::with_capacity(ARENA_FLOATS),
            samples: SamplePool::new(),
            drums: Drums::new(sample_rate),
        }
    }

    /// Decode and apply a command. Returns 0 (OK) or a negative error code.
    /// Telemetry slot 7 holds the most recent *failed* code; successes leave it.
    pub fn command(&mut self, op: u32, a: f64, b: f64, c: f64, d: f64) -> i32 {
        let code = match protocol::decode(op, a, b, c, d) {
            Ok(cmd) => {
                self.handle(cmd);
                protocol::OK
            }
            Err(e) => e,
        };
        if code != protocol::OK {
            self.telemetry[7] = code as f64;
        }
        code
    }

    fn handle(&mut self, cmd: Command) {
        match cmd {
            // MIDI convention: NoteOn with velocity 0 is a NoteOff.
            Command::NoteOn { note, velocity: 0 } => self.tone.note_off(note),
            Command::NoteOn { note, velocity } => self.tone.note_on(note, velocity),
            Command::NoteOff { note } => self.tone.note_off(note),
            Command::SetMasterGain { gain } => self.master_gain = gain,
            // Already playing: no-op (does not restart).
            Command::Play => {
                self.transport.playing = true;
                self.sync_transport_telemetry();
            }
            Command::Stop => {
                self.transport.playing = false;
                self.transport.ticks = 0.0;
                self.drums.fade_all(); // no hard cuts: 2 ms fade-out
                self.sync_transport_telemetry();
            }
            // Applies from the next block; the playhead position is unchanged.
            Command::SetTempo { bpm } => self.transport.bpm = bpm,
            Command::SetMetronome { on } => self.metronome.on = on,
            // Resets the slot to defaults and silences its voices.
            Command::AddDrumTrack { slot } => self.drums.add_track(slot),
            Command::RemoveTrack { slot } => self.drums.remove_track(slot),
            // Row/step edits on an inactive slot succeed and just store state.
            // Steps are stored for any step < MAX_STEPS (decode checks that),
            // even beyond step_count.
            Command::SetRowSample { slot, row, sample } => {
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.sample = sample;
                }
            }
            Command::SetRowGain { slot, row, gain } => {
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.gain = gain;
                }
            }
            Command::SetRowPan { slot, row, pan } => {
                if let Some(r) = self.drums.row_mut(slot, row) {
                    r.pan = pan;
                }
            }
            Command::SetRowMute { slot, row, mute } => self.drums.set_row_mute(slot, row, mute),
            Command::SetStep { slot, row, step, velocity } => {
                if let Some(r) = self.drums.row_mut(slot, row) {
                    if let Some(s) = r.steps.get_mut(step) {
                        *s = velocity;
                    }
                }
            }
            Command::SetStepCount { slot, count } => {
                if let Some(t) = self.drums.tracks.get_mut(slot) {
                    t.step_count = count;
                }
            }
            Command::SetSwing { slot, swing } => {
                if let Some(t) = self.drums.tracks.get_mut(slot) {
                    t.swing = swing;
                }
            }
        }
    }

    /// Render one block, overwriting both buffers. Frames beyond
    /// `MAX_BLOCK` or beyond the shorter buffer are zeroed, never panicking.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let n = left.len().min(right.len()).min(MAX_BLOCK);
        self.tone.render_add(&mut left[..n], &mut right[..n]);
        self.render_metronome(&mut left[..n], &mut right[..n]);
        self.render_drums(&mut left[..n], &mut right[..n]);
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
        self.telemetry[0] += 1.0;
        self.sync_transport_telemetry();
        self.telemetry[5] = pl as f64;
        self.telemetry[6] = pr as f64;
    }

    /// Slot 1: playing (0/1); slot 2: playhead ticks at the start of the next block.
    fn sync_transport_telemetry(&mut self) {
        self.telemetry[1] = if self.transport.playing { 1.0 } else { 0.0 };
        self.telemetry[2] = self.transport.ticks;
    }

    /// Metronome: trigger clicks at their exact sample offsets, rendering the
    /// segments between them so a click spilling past the block end continues
    /// next block. Does not advance the transport.
    fn render_metronome(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        let mut starts = [(0usize, false); 4];
        let mut count = 0;
        if self.transport.playing && self.metronome.on && n > 0 {
            let spt = self.transport.samples_per_tick(self.sample_rate);
            let (t0, t1) = self.transport.block_window(n, self.sample_rate);
            events_in_window(t0, t1, BAR_TICKS, &BEAT_OFFSETS, |beat, tick| {
                if count < starts.len() {
                    starts[count] = (tick_to_offset(tick, t0, spt, n), beat == 0);
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

    fn fail(&mut self, code: i32) -> i32 {
        self.telemetry[7] = code as f64;
        code
    }

    /// Reserve space for sample `id` (planar `[L..., R...]`, `frames*channels`
    /// floats) and return a pointer the UI fills, then call `sample_ready`.
    /// Replaces any existing sample in the slot (old data leaks until reset)
    /// and marks it not ready. May grow the heap only while stopped; while
    /// playing and out of room, returns `ERR_DEFERRED` so the caller retries
    /// after stopping. Failures also land in telemetry slot 7.
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
            return Err(self.fail(protocol::ERR_DEFERRED));
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

    pub fn telemetry(&self) -> &[f64; 8] {
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
    fn note_on_produces_440hz() {
        let mut e = Engine::new(SR);
        assert_eq!(e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0), 0);
        let s = render(&mut e, 24000); // 0.5 s
        let skip = (0.005 * SR) as usize + 1;
        let ups: Vec<usize> =
            (skip..s.len()).filter(|&i| s[i - 1] < 0.0 && s[i] >= 0.0).collect();
        assert!(ups.len() > 100);
        let periods = (ups.len() - 1) as f32;
        let freq = periods * SR / (ups[ups.len() - 1] - ups[0]) as f32;
        assert!((freq - 440.0).abs() < 2.0, "freq {freq}");
    }

    #[test]
    fn note_on_starts_without_click() {
        let mut e = Engine::new(SR);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        let s = render(&mut e, 1280);
        assert!(s[0].abs() < 0.01);
        assert!(s.windows(2).all(|w| (w[1] - w[0]).abs() <= 0.05));
    }

    #[test]
    fn note_off_releases_to_silence_within_60ms() {
        let mut e = Engine::new(SR);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        render(&mut e, 4800);
        e.command(OP_NOTE_OFF, 69.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 128 * 23); // 61 ms
        assert!(s[s.len() - 128..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn velocity_zero_note_on_is_note_off() {
        let mut e = Engine::new(SR);
        e.command(OP_NOTE_ON, 69.0, 100.0, 0.0, 0.0);
        e.command(OP_NOTE_ON, 69.0, 0.0, 0.0, 0.0);
        let s = render(&mut e, 128 * 23);
        assert!(s[s.len() - 128..].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn peak_telemetry_tracks_output() {
        let mut e = Engine::new(SR);
        e.command(OP_NOTE_ON, 69.0, 127.0, 0.0, 0.0);
        render(&mut e, 4800);
        let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
        e.process(&mut l, &mut r);
        let pk = l.iter().fold(0.0f32, |m, x| m.max(x.abs())) as f64;
        assert!(pk > 0.1 && pk <= 0.16 + 1e-6);
        assert_eq!(e.telemetry()[5], pk);
        assert_eq!(e.telemetry()[6], pk);
        assert_eq!(e.telemetry()[0], 38.0);
    }

    #[test]
    fn bad_command_returns_error_and_keeps_rendering() {
        let mut e = Engine::new(SR);
        assert_eq!(e.command(999, 0.0, 0.0, 0.0, 0.0), -1);
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
        OP_ADD_DRUM_TRACK, OP_REMOVE_TRACK, OP_SET_ROW_MUTE, OP_SET_ROW_PAN, OP_SET_ROW_SAMPLE,
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

    #[test]
    fn retrigger_declicks() {
        let mut e = Engine::new(SR);
        e.command(OP_SET_TEMPO, 120.0, 0.0, 0.0, 0.0);
        load_const(&mut e, 0, 48000, 1.0);
        drum_setup(&mut e, 0.0, 0.0, &[0.0, 1.0]);
        e.command(OP_PLAY, 0.0, 0.0, 0.0, 0.0);
        let (l, _) = render2(&mut e, 128 * 46); // 5888 frames
        // Single-sample blocks from 5888 find exactly when the crossfade
        // starts and ends: the fade must be exactly 96 samples long.
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
        // no jump anywhere after the initial onset at 0
        let worst = (1..l.len()).map(|i| (l[i] - l[i - 1]).abs()).fold(0.0f32, f32::max);
        assert!(worst <= 0.1, "worst jump {worst}");
        assert!((l[5990] - 0.5657).abs() < 1e-3);
        assert!((l[6100] - 0.5657).abs() < 1e-3);
        assert!(e.drums.tracks[0].voices[0].active.live_for_test());
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
}
