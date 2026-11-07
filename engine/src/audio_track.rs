//! Audio tracks: audio clips on the song timeline, played from the sample
//! pool at native speed (plan 9; spec addendum §3.1).
//!
//! # Model
//! A track slot of kind Audio (`SlotKind::Audio` in `engine.rs`) owns
//! `MAX_CLIPS` [`AudioClip`] slots, all preallocated here (one
//! [`AudioTracks`] per engine, built in `Engine::new`). A clip is
//! `{sample, start, len, offset_frames, looped, gain, fade_in, fade_out}`:
//! `start`, `len` and the fades are song ticks, the offset (the trim start)
//! is frames into the file (the protocol sends seconds; the engine converts
//! at its own rate, so the UI's replay builder needs no sample rate).
//!
//! # Staging
//! One edit is three commands. `AUDIO_CLIP_SOURCE` (sample, offset, loop)
//! and `AUDIO_CLIP_GAIN` (gain, fades) only write the clip slot's *staged*
//! copy; `AUDIO_CLIP_SET` (start, len) commits the staged values with the
//! position and activates the clip. Commands apply between blocks, so the
//! audio thread never plays a half-applied edit. The staged copy is kept
//! after a commit (a later SET alone re-commits it) and reset with the track.
//!
//! # Playback (Song mode only)
//! At song tick `t` inside the clip the file plays at frame
//! `offset + (t − start) × samplesPerTick`, taken modulo the file length
//! when `looped`. Frame `i` of a piece with window `[t0, t1)` is at tick
//! `t0 + i / spt`; the clip covers the frames whose tick lies in
//! `[start, end)` (the first one at `ceil((start − t0) × spt)`, the
//! transport's own wrap rule), and a voice entering mid-clip starts at file
//! frame `offset + floor((t0 − start) × spt)`, the frame a voice running
//! since `start` would have reached. Voices read the planar data through
//! [`SampleView::playable`] and interpolate nothing: the rate is native.
//!
//! **A voice advances by frames, never by ticks**, so a tempo change never
//! makes it jump; its position is recomputed only on a *chase*. Each clip
//! slot has one [`AudioVoice`]: `Idle` (chases on the next piece the
//! playhead is inside the clip and its sample is playable), `Playing`, or
//! `Done` (a one-shot file ran out; it waits for a jump, an edit of its
//! mapping or a new generation of its sample, so a faster tempo cannot
//! replay the file's end).
//!
//! A chase happens on Play, a seek, a loop wrap, a loop set behind the
//! playhead, a mode switch, Stop (the engine calls [`AudioTracks::jump`],
//! which cuts every voice; the next piece re-chases), an edit that changes
//! the clip's sample, offset, loop or start (`commit`), and a sample that
//! becomes ready (or is replaced) while the playhead is inside the clip.
//! Changing only the length, the gain or the fades keeps the voice; the
//! gain ramps linearly to its new value over 5 ms, and so does the user-fade
//! factor (`env_d`: the old factor blends into the new one), so a fade
//! handle or the clip end dragged across the playhead never steps.
//!
//! # Fades (declicking, `CLIP_FADE_SECONDS` = 2 ms)
//! * A start at file position 0 is unfaded (it keeps the transient); any
//!   other start (a chase, a trimmed clip, a late sample) fades in.
//! * Every clip end fades out so the fade ends exactly at the clip end. That
//!   fade always runs in full: an end that a resize or a tempo change puts
//!   less than 2 ms ahead before its fade began, or an end moved while its
//!   fade runs, cuts the voice instead (the hold-and-fade may then run up to
//!   2 ms past the clip end), and a chased start inside the last 2 ms of a
//!   clip does not play.
//! * A one-shot (non-loop) file's last 2 ms fade out too, so a file cut
//!   mid-signal (a trimmed export, a clip that outlives its file after a
//!   tempo change) never ends in a step. The repeat seam of a loop clip is
//!   not faded: a loop file is assumed to loop seamlessly.
//! * The user's fade-in and fade-out are linear (in frames at the current
//!   tempo) and multiply with the declick fades and the gain.
//! * A cut voice (jump, Stop, removal, a generation change, its clip moved
//!   away from the playhead) holds its last output sample and fades it out
//!   over 2 ms (`tail`), the drum voices' hold-and-fade. A chase into the
//!   same clip fades in while the tail fades out, a linear cross-over.
//!
//! # Sample generations
//! A voice captures the sample's generation when it starts and plays on
//! only while `playable` reports the same one (`samples.rs`). A replaced,
//! un-readied or reset sample is therefore never read by an old voice: it is
//! cut (hold-and-fade, no reads) and chases into the new upload once that is
//! ready.
//!
//! A mono file plays the same signal on L and R. Everything here is
//! fixed-size; rendering never allocates, blocks or panics.

use crate::arrangement::Timeline;
use crate::mixer::StereoBufs;
use crate::protocol::{ERR_BAD_INDEX, ERR_BAD_VALUE};
use crate::samples::SampleView;
use crate::{CLIP_FADE_SECONDS, MAX_CLIPS, MAX_SAMPLE_FLOATS, MAX_TRACKS};

/// The gain ramp after a gain-only edit (seconds).
const GAIN_RAMP_SECONDS: f32 = 0.005;

/// Float-noise tolerance (frames) when mapping ticks to frames (the
/// playhead carries ~1e-12 ticks of noise; see `transport.rs`).
const SNAP: f64 = 1e-6;

/// One audio clip on a track's song timeline. An inactive clip is ignored.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioClip {
    pub active: bool,
    /// Sample id (`None`: a clip with no file, silent).
    pub sample: Option<u32>,
    /// First song tick.
    pub start: u32,
    /// Length in ticks, `>= 1`; `start + len <= MAX_SONG_TICKS`.
    pub len: u32,
    /// File frame played at `start` (`<= MAX_SAMPLE_FLOATS`).
    pub offset_frames: u32,
    /// Repeat the file to fill the clip.
    pub looped: bool,
    /// Linear gain, `0..=MAX_CLIP_GAIN`.
    pub gain: f32,
    /// User fades in ticks; `fade_in + fade_out <= len`.
    pub fade_in: u32,
    pub fade_out: u32,
}

impl AudioClip {
    /// An empty slot.
    pub const OFF: AudioClip = AudioClip {
        active: false,
        sample: None,
        start: 0,
        len: 0,
        offset_frames: 0,
        looped: false,
        gain: 1.0,
        fade_in: 0,
        fade_out: 0,
    };

    /// First song tick after the clip.
    pub fn end(&self) -> u32 {
        self.start.saturating_add(self.len)
    }

    /// Does the clip play the same file frame at every tick as `o`? A
    /// commit that changes this chases; one that keeps it (only the length,
    /// gain or fades changed) keeps the voice.
    fn same_mapping(&self, o: &AudioClip) -> bool {
        self.active == o.active
            && self.sample == o.sample
            && self.offset_frames == o.offset_frames
            && self.looped == o.looped
            && self.start == o.start
    }
}

/// The staged half of a clip edit (written by SOURCE and GAIN).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Staged {
    sample: Option<u32>,
    offset_frames: u32,
    looped: bool,
    gain: f32,
    fade_in: u32,
    fade_out: u32,
}

impl Staged {
    const DEFAULT: Staged = Staged { sample: None, offset_frames: 0, looped: false, gain: 1.0, fade_in: 0, fade_out: 0 };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Not playing: chases when the playhead is inside its clip.
    Idle,
    Playing,
    /// A one-shot file ended: silent until a jump or an edit.
    Done,
}

/// The voice of one clip slot (see the module docs).
#[derive(Clone, Copy, Debug)]
struct AudioVoice {
    state: State,
    sample: u32,
    /// Sample generation captured at the start (`samples.rs`).
    generation: u32,
    /// File frame of the next output frame (whole frames; f64 so a chase
    /// computes it exactly).
    pos: f64,
    /// Gain applied now, the target it ramps to, the step per frame and the
    /// frames left of the ramp (it lands exactly on the target).
    gain: f32,
    gain_target: f32,
    gain_step: f32,
    gain_left: u32,
    /// Frames of the 2 ms declick fade-in done (`>= fade`: full level).
    rise: u32,
    /// The clip-end declick fade has begun (see `render_voice`).
    ending: bool,
    /// An edit that kept the voice changed the clip's length or fades: the
    /// old `(len, fade_in, fade_out)`, turned into `env_d` on the next piece.
    env_prev: Option<(u32, u32, u32)>,
    /// The user-fade blend: `env_d × env_left / ramp` is added to the new
    /// user-fade factor, so it moves from the old value to the new one
    /// linearly over the 5 ms ramp instead of stepping.
    env_d: f32,
    env_left: u32,
    /// The last frame this voice played (its playback, not its tail).
    last_l: f32,
    last_r: f32,
    /// Hold-and-fade: a held sample, faded linearly over `fade` frames.
    tail_l: f32,
    tail_r: f32,
    tail_left: u32,
}

impl AudioVoice {
    const OFF: AudioVoice = AudioVoice {
        state: State::Idle,
        sample: 0,
        generation: 0,
        pos: 0.0,
        gain: 1.0,
        gain_target: 1.0,
        gain_step: 0.0,
        gain_left: 0,
        rise: 0,
        ending: false,
        env_prev: None,
        env_d: 0.0,
        env_left: 0,
        last_l: 0.0,
        last_r: 0.0,
        tail_l: 0.0,
        tail_r: 0.0,
        tail_left: 0,
    };

    /// Playing or still fading a tail.
    fn sounding(&self) -> bool {
        self.state == State::Playing || self.tail_left > 0
    }

    /// Stop now and become `Idle` (it chases again when it can). A playing
    /// voice holds its last output, plus whatever its previous tail still
    /// sounds, and fades that out over `fade` frames: no step, no reads.
    fn cut(&mut self, fade: u32) {
        if self.state == State::Playing {
            let fade = fade.max(1);
            let k = self.tail_left as f32 / fade as f32;
            self.tail_l = self.tail_l * k + self.last_l;
            self.tail_r = self.tail_r * k + self.last_r;
            self.tail_left = if self.tail_l != 0.0 || self.tail_r != 0.0 { fade } else { 0 };
        }
        self.last_l = 0.0;
        self.last_r = 0.0;
        self.state = State::Idle;
    }

    /// Stop without a tail: the output already faded to 0 (a clip end, a
    /// one-shot file end).
    fn finish(&mut self, state: State) {
        self.last_l = 0.0;
        self.last_r = 0.0;
        self.state = state;
    }
}

/// The clips of one Audio track slot, their staged edits and their voices.
pub struct AudioTrack {
    clips: [AudioClip; MAX_CLIPS],
    staged: [Staged; MAX_CLIPS],
    voices: [AudioVoice; MAX_CLIPS],
    /// High-water mark: every active clip and every sounding voice has an
    /// index below this.
    used: usize,
}

impl AudioTrack {
    fn new() -> AudioTrack {
        AudioTrack {
            clips: [AudioClip::OFF; MAX_CLIPS],
            staged: [Staged::DEFAULT; MAX_CLIPS],
            voices: [AudioVoice::OFF; MAX_CLIPS],
            used: 0,
        }
    }

    /// Drop trailing slots with no clip and no sound from the high-water mark.
    fn shrink(&mut self) {
        while self.used > 0 {
            let k = self.used - 1;
            let busy = self.clips.get(k).is_some_and(|c| c.active) || self.voices.get(k).is_some_and(|v| v.sounding());
            if busy {
                break;
            }
            self.used = k;
        }
    }
}

/// Every slot's audio clips (see the module docs).
pub struct AudioTracks {
    tracks: Vec<AudioTrack>,
    sample_rate: f32,
    /// The 2 ms declick fade, in frames.
    fade: u32,
    /// The 5 ms gain ramp, in frames.
    ramp: u32,
}

impl AudioTracks {
    /// All `MAX_TRACKS` slots, preallocated (the only allocation here).
    pub fn new(sample_rate: f32) -> AudioTracks {
        let frames = |s: f32| ((s * sample_rate).round() as u32).max(1);
        AudioTracks {
            tracks: (0..MAX_TRACKS).map(|_| AudioTrack::new()).collect(),
            sample_rate,
            fade: frames(CLIP_FADE_SECONDS),
            ramp: frames(GAIN_RAMP_SECONDS),
        }
    }

    fn staged_mut(&mut self, slot: usize, idx: usize) -> Result<&mut Staged, i32> {
        self.tracks.get_mut(slot).and_then(|t| t.staged.get_mut(idx)).ok_or(ERR_BAD_INDEX)
    }

    /// `AUDIO_CLIP_SOURCE`: stage the sample, the offset (seconds, converted
    /// to frames at the engine rate and clamped to `MAX_SAMPLE_FLOATS`
    /// frames, past any file's end) and the loop flag. Clamped, not
    /// refused: the UI cannot know the engine rate, and a refused SOURCE
    /// would let the GAIN + SET that follow commit a stale staged source.
    /// (Negative or non-finite offsets never get here: `decode` refuses them.)
    pub fn stage_source(&mut self, slot: usize, idx: usize, sample: Option<u32>, offset: f64, looped: bool) -> Result<(), i32> {
        let frames = (offset * self.sample_rate as f64).round();
        if !(frames >= 0.0) {
            return Err(ERR_BAD_VALUE);
        }
        let frames = frames.min(MAX_SAMPLE_FLOATS as f64);
        let s = self.staged_mut(slot, idx)?;
        (s.sample, s.offset_frames, s.looped) = (sample, frames as u32, looped);
        Ok(())
    }

    /// `AUDIO_CLIP_GAIN`: stage the gain and the fades (ticks).
    pub fn stage_gain(&mut self, slot: usize, idx: usize, gain: f32, fade_in: u32, fade_out: u32) -> Result<(), i32> {
        let s = self.staged_mut(slot, idx)?;
        (s.gain, s.fade_in, s.fade_out) = (gain, fade_in, fade_out);
        Ok(())
    }

    /// `AUDIO_CLIP_SET`: commit the staged source and gain at `start` / `len`
    /// and activate the clip. The fades must fit the clip (`ERR_BAD_VALUE`,
    /// nothing changes). A commit that moves what plays under a tick (sample,
    /// offset, loop, start) cuts the voice, which chases on the next piece;
    /// one that changes only the length, gain or fades keeps it.
    pub fn commit(&mut self, slot: usize, idx: usize, start: u32, len: u32) -> Result<(), i32> {
        let fade = self.fade;
        let t = self.tracks.get_mut(slot).ok_or(ERR_BAD_INDEX)?;
        let (Some(s), Some(c), Some(v)) = (t.staged.get(idx), t.clips.get_mut(idx), t.voices.get_mut(idx)) else {
            return Err(ERR_BAD_INDEX);
        };
        if s.fade_in as u64 + s.fade_out as u64 > len as u64 {
            return Err(ERR_BAD_VALUE);
        }
        let clip = AudioClip {
            active: true,
            sample: s.sample,
            start,
            len,
            offset_frames: s.offset_frames,
            looped: s.looped,
            gain: s.gain,
            fade_in: s.fade_in,
            fade_out: s.fade_out,
        };
        if !clip.same_mapping(c) {
            v.cut(fade);
        } else if v.state == State::Playing {
            if v.ending && clip.end() != c.end() {
                // The end moved while its declick fade ran: the fade would
                // jump. Cut (hold-and-fade); the voice chases with a fade-in.
                v.cut(fade);
            } else if (clip.len, clip.fade_in, clip.fade_out) != (c.len, c.fade_in, c.fade_out) && v.env_prev.is_none() {
                // Keep the oldest envelope since the last piece: that is
                // what sounds now.
                v.env_prev = Some((c.len, c.fade_in, c.fade_out));
            }
        }
        *c = clip;
        t.used = t.used.max(idx + 1);
        Ok(())
    }

    /// `CLIP_REMOVE`: empty clip slot `idx` and reset its staged edit; its
    /// voice fades out.
    pub fn remove_clip(&mut self, slot: usize, idx: usize) {
        let fade = self.fade;
        let Some(t) = self.tracks.get_mut(slot) else { return };
        if let (Some(c), Some(v), Some(s)) = (t.clips.get_mut(idx), t.voices.get_mut(idx), t.staged.get_mut(idx)) {
            *c = AudioClip::OFF;
            *s = Staged::DEFAULT;
            v.cut(fade);
        }
    }

    /// Every clip of `slot` removed and its staged edits reset; sounding
    /// voices fade out (`CLIP_CLEAR`, and any track added or removed there).
    pub fn clear_track(&mut self, slot: usize) {
        let fade = self.fade;
        let Some(t) = self.tracks.get_mut(slot) else { return };
        let used = t.used.min(MAX_CLIPS);
        t.clips[..used].fill(AudioClip::OFF);
        for v in t.voices[..used].iter_mut() {
            v.cut(fade);
        }
        t.staged.fill(Staged::DEFAULT);
    }

    /// A jump of song time (Play, seek, wrap, loop set behind the playhead,
    /// mode switch, Stop): every voice is cut and re-chases on the next piece.
    pub fn jump(&mut self) {
        let fade = self.fade;
        for t in self.tracks.iter_mut() {
            let used = t.used.min(MAX_CLIPS);
            for v in t.voices[..used].iter_mut() {
                v.cut(fade);
            }
        }
    }

    /// Engine reset (`RESET_ALL`): every clip, staged edit and voice gone at
    /// once, no fade (the engine fades its output). Allocation-free.
    pub fn reset_all(&mut self) {
        for t in self.tracks.iter_mut() {
            t.clips.fill(AudioClip::OFF);
            t.staged.fill(Staged::DEFAULT);
            t.voices.fill(AudioVoice::OFF);
            t.used = 0;
        }
    }

    /// Clip slot `idx` of `slot` (`None` if out of range).
    pub fn clip(&self, slot: usize, idx: usize) -> Option<AudioClip> {
        self.tracks.get(slot)?.clips.get(idx).copied()
    }

    /// Render frames `from..to` (one piece) of every Audio track into its
    /// buffer in `tracks`. `window` is the piece's `(t0, t1, spt)` while
    /// playing; clips play only with a window in Song mode (`timeline`),
    /// otherwise only tails sound. Returns the mask of slots that sounded.
    pub fn render_add(
        &mut self,
        window: Option<(f64, f64, f64)>,
        timeline: Timeline,
        samples: SampleView,
        tracks: &mut StereoBufs,
        (from, to): (usize, usize),
    ) -> u32 {
        let win = match timeline {
            Timeline::Song(_) => window.filter(|&(_, _, spt)| spt > 0.0 && spt.is_finite()),
            Timeline::Pattern => None,
        };
        let (fade, ramp) = (self.fade, self.ramp);
        let mut sounding = 0u32;
        for (slot, t) in self.tracks.iter_mut().enumerate() {
            if t.used == 0 {
                continue;
            }
            let Some((l, r)) = tracks.pair_mut(slot, from, to) else { continue };
            let used = t.used.min(MAX_CLIPS);
            let mut any = false;
            for (c, v) in t.clips[..used].iter().zip(t.voices[..used].iter_mut()) {
                any |= render_voice(v, c, win, samples, fade, ramp, l, r);
            }
            t.shrink();
            if any {
                sounding |= 1 << slot;
            }
        }
        sounding
    }
}

/// One clip slot for one piece: validate a playing voice, chase an idle
/// one, then add its tail and its playback into `l`/`r`. Returns whether it
/// sounded.
#[allow(clippy::too_many_arguments)]
fn render_voice(
    v: &mut AudioVoice,
    c: &AudioClip,
    win: Option<(f64, f64, f64)>,
    samples: SampleView,
    fade: u32,
    ramp: u32,
    l: &mut [f32],
    r: &mut [f32],
) -> bool {
    let n = l.len().min(r.len());
    // A finished one-shot whose sample was replaced (or un-readied) since:
    // idle again, so it chases into the new upload once that is playable.
    if v.state == State::Done && c.active {
        let g = c.sample.and_then(|id| samples.playable(id as usize)).map(|p| p.3);
        if g != Some(v.generation) {
            v.state = State::Idle;
        }
    }
    if v.state != State::Playing && v.tail_left == 0 && (v.state == State::Done || !(c.active && win.is_some())) {
        return false; // the common case: nothing sounds and nothing can start
    }
    let data = if c.active { c.sample.and_then(|id| samples.playable(id as usize)) } else { None };
    // A playing voice whose song window, clip, sample or generation went
    // away (or whose clip now ends at or before the playhead) is cut.
    if v.state == State::Playing {
        let keep = match (win, data) {
            (Some((t0, _, spt)), Some((.., g))) => {
                // The end fade must start in full: an end that a resize or a
                // tempo change put less than the fade ahead, with the fade
                // not yet running, is a cut (the hold-and-fade may run up to
                // 2 ms past the clip end) rather than a part-way fade.
                let ie = ((c.end() as f64 - t0) * spt - SNAP).ceil();
                c.sample == Some(v.sample) && g == v.generation && ie > 0.0 && (v.ending || ie + 1.0 >= fade as f64)
            }
            _ => false,
        };
        if !keep {
            v.cut(fade);
        }
    }
    // An idle voice inside its clip, with a playable sample, chases.
    let mut first = 0usize;
    if let (State::Idle, Some((t0, _, spt)), Some((_, frames, _, g)), Some(id)) = (v.state, win, data, c.sample) {
        let xs = (c.start as f64 - t0) * spt;
        let xe = (c.end() as f64 - t0) * spt;
        let i0 = if xs > SNAP { (xs - SNAP).ceil() } else { 0.0 };
        let ie = (xe - SNAP).ceil();
        if i0 < n as f64 && i0 < ie && frames > 0 {
            let elapsed = if xs > -SNAP { 0.0 } else { (SNAP - xs).floor() };
            let mut pos = c.offset_frames as f64 + elapsed;
            if c.looped {
                pos %= frames as f64;
            }
            if !c.looped && pos >= frames as f64 {
                v.generation = g; // a replacement chases (see above)
                v.finish(State::Done); // entered after the file's end
            } else if pos != 0.0 && ie + 1.0 < fade as f64 {
                // A faded start whose clip ends inside the declick fade
                // (also the voice just cut for that reason): too short to
                // play; stays idle.
            } else {
                *v = AudioVoice {
                    state: State::Playing,
                    sample: id,
                    generation: g,
                    pos,
                    gain: c.gain,
                    gain_target: c.gain,
                    gain_step: 0.0,
                    gain_left: 0,
                    rise: if pos == 0.0 { fade } else { 0 },
                    ending: false,
                    env_prev: None,
                    env_d: 0.0,
                    env_left: 0,
                    ..*v
                };
                first = i0 as usize;
            }
        }
    }
    let sounded = v.sounding();
    // The tail of a cut voice: its held sample, fading.
    if v.tail_left > 0 {
        let inv = 1.0 / fade.max(1) as f32;
        for (a, b) in l[..n].iter_mut().zip(r[..n].iter_mut()) {
            if v.tail_left == 0 {
                break;
            }
            let k = v.tail_left as f32 * inv;
            *a += v.tail_l * k;
            *b += v.tail_r * k;
            v.tail_left -= 1;
        }
    }
    if v.state != State::Playing {
        return sounded;
    }
    let (Some((t0, _, spt)), Some((d, frames, ch, _))) = (win, data) else {
        v.cut(fade); // unreachable: checked above
        return sounded;
    };
    // A gain-only edit: ramp to the new gain over `ramp` frames.
    if c.gain != v.gain_target {
        v.gain_target = c.gain;
        v.gain_left = ramp.max(1);
        v.gain_step = (c.gain - v.gain) / v.gain_left as f32;
    }
    let xs = (c.start as f64 - t0) * spt;
    let xe = (c.end() as f64 - t0) * spt;
    // The first frame at or after the clip end (unclamped: the end fade
    // spans pieces).
    let ie = (xe - SNAP).ceil();
    let stop = if ie < n as f64 { ie.max(0.0) as usize } else { n };
    let fade_f = fade.max(1) as f32;
    let (fi, fo) = (c.fade_in as f64 * spt, c.fade_out as f64 * spt);
    let ramp_f = ramp.max(1) as f32;
    // A length or fade edit that kept the voice: blend from the old user-fade
    // factor at this frame (including a blend still running) to the new one.
    if let Some((len, fi_old, fo_old)) = v.env_prev.take() {
        let xe_old = (c.start as f64 + len as f64 - t0) * spt;
        let at = first as f64;
        let old = user_fades(at, xs, xe_old, fi_old as f64 * spt, fo_old as f64 * spt) + v.env_d * v.env_left as f32 / ramp_f;
        v.env_d = old - user_fades(at, xs, xe, fi, fo);
        v.env_left = ramp.max(1);
    }
    let (dl, dr) = d.split_at(frames.min(d.len()));
    let stereo = ch == 2;
    for i in first..stop {
        let mut p = v.pos as usize;
        if p >= frames {
            if !c.looped {
                v.finish(State::Done);
                break;
            }
            v.pos = 0.0; // the loop seam: no fade
            p = 0;
        }
        let Some(&a) = dl.get(p) else {
            v.cut(fade);
            break;
        };
        let b = if stereo { dr.get(p).copied().unwrap_or(a) } else { a };
        let mut env = v.gain;
        if v.rise < fade {
            env *= v.rise as f32 / fade_f;
            v.rise += 1;
        }
        let to_end = (ie - i as f64) as f32 / fade_f;
        if to_end < 1.0 {
            env *= to_end;
            v.ending = true;
        }
        if !c.looped {
            let left = (frames - p) as f32 / fade_f;
            if left < 1.0 {
                env *= left;
            }
        }
        let mut user = user_fades(i as f64, xs, xe, fi, fo);
        if v.env_left > 0 {
            user += v.env_d * v.env_left as f32 / ramp_f;
            v.env_left -= 1;
        }
        env *= user;
        let (ol, or) = (a * env, b * env);
        l[i] += ol;
        r[i] += or;
        (v.last_l, v.last_r) = (ol, or);
        if v.gain_left > 0 {
            v.gain_left -= 1;
            v.gain = if v.gain_left == 0 { v.gain_target } else { v.gain + v.gain_step };
        }
        v.pos += 1.0;
    }
    // Reached the clip end inside this piece: the end fade took it to 0.
    if v.state == State::Playing && ie <= n as f64 {
        v.finish(State::Idle);
    }
    true
}

/// The user's linear fade-in × fade-out factor at frame `i` of a piece whose
/// clip starts at frame `xs` and ends at frame `xe` (both fractional), with
/// fades of `fi` / `fo` frames (0: none).
fn user_fades(i: f64, xs: f64, xe: f64, fi: f64, fo: f64) -> f32 {
    let mut u = 1.0f32;
    if fi > 0.0 {
        let x = ((i - xs) / fi) as f32;
        if x < 1.0 {
            u *= x.max(0.0);
        }
    }
    if fo > 0.0 {
        let x = ((xe - i) / fo) as f32;
        if x < 1.0 {
            u *= x.max(0.0);
        }
    }
    u
}
