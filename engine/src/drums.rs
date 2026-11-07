//! Drum tracks: per-track step patterns with swing, and declicked sample voices.
//!
//! # Patterns
//! A track holds `MAX_PATTERNS` [`DrumPattern`]s (steps of every row, step
//! count, swing), all preallocated inline. Rows (sample, gain, pan, mute) and
//! voices belong to the track, so every pattern plays through the same rows.
//! The track plays and edits its *current* pattern (`DrumTrack::current`).
//! Switching patterns needs no release: a sounding hit just rings out (its
//! voice is per row), and the new pattern's steps are placed from the same
//! absolute playhead, i.e. at `ticks mod newPeriod`. Adding a track resets all
//! its patterns and selects pattern 0.
//!
//! Everything is fixed-size and preallocated (`Drums::new` is the only place
//! that allocates). Rendering never allocates, blocks or panics.
//!
//! Declicking rules (the project's #1 anti-goal is clicks):
//! * Each row owns two voice slots: `active` and `fading`.
//! * A retrigger over a still-sounding voice moves the old voice to `fading`,
//!   which ramps 1 -> 0 over ~2 ms (so the old sound never jumps). The new
//!   voice starts at FULL level, exactly like a first hit: its attack is the
//!   sample's own content, and a fade-in would dull every kick/hat attack
//!   (ruling R11).
//! * Stop / mute / track removal move sounding voices to `fading` (2 ms).
//! * Known limit: if a row is retriggered twice within one fade (2 ms), the
//!   older fading voice is dropped. Only reachable at absurd settings (swing
//!   changes cannot cause it: see swing latching below).
//!
//! Swing latching (ruling R12): `SetSwing` only stores `swing_next`. The swing
//! that places steps (`swing`) is latched from it when the playhead crosses a
//! step-pair boundary (a multiple of `2 * STEP_TICKS`), or immediately while
//! stopped. An odd step always lies strictly inside its pair (at most
//! `0.5 * STEP_TICKS` late), so it can never move across the playhead: a
//! swing change never double-fires or skips a step. The latch belongs to
//! whoever plays the pattern:
//! * Pattern mode: the pattern's own `swing`, and only the pattern that is
//!   playing (the current one) latches; a pattern switched away from keeps its
//!   pending `swing_next` until it plays again and crosses a pair boundary (so
//!   switching A -> B -> A inside one pair cannot move an A step across the
//!   playhead either).
//! * Song mode: every clip has its own latch (`DrumTrack::clip_swing`),
//!   latched at pair boundaries of the clip's own pattern time, so two
//!   overlapping clips of one pattern at different phases cannot move each
//!   other's steps. A clip also latches at once where nothing of it has
//!   played yet: at its start, when it is edited into a new mapping or before
//!   it reached the playhead (see `ClipSet` in engine.rs; a clip only
//!   lengthened or shortened under the playhead keeps its latch), and on every
//!   jump of song time (Play, seek, loop wrap, mode switch:
//!   `Drums::latch_clips`).
//!
//! # Song mode
//! A clip plays its pattern's steps mapped through `Clip::pattern_window`;
//! a hit simply stops retriggering at the clip end (its voice rings out, as
//! for a pattern switch: nothing to release). Overlapping clips all play;
//! hits on one row from two clips at the same sample retrigger the row (the
//! older voice fades over 2 ms).

use crate::arena::{SampleArena, SampleSlice};
use crate::arrangement::{for_each_overlapping, Clip, Timeline};
use crate::samples::SamplePool;
use crate::transport::{events_in_window, tick_to_offset};
use crate::mixer::StereoBufs;
use crate::{MAX_CLIPS, MAX_KEYS, MAX_PATTERNS, MAX_ROWS, MAX_STEPS, MAX_TRACKS, STEP_TICKS};

/// Max step events handled per track per block (a block spans at most a
/// couple of steps at any sane tempo/block size, per playing clip; extras are
/// dropped, not UB: drums have nothing to release).
const MAX_EVENTS: usize = 32;

/// A step to trigger: sample offset in the block, step index and pattern.
#[derive(Clone, Copy)]
struct Hit {
    offset: usize,
    step: u8,
    pattern: u8,
}

impl Hit {
    const NONE: Hit = Hit { offset: 0, step: 0, pattern: 0 };
}

/// Fixed-capacity, offset-ordered list of one track's hits in a block.
struct Hits {
    ev: [Hit; MAX_EVENTS],
    len: usize,
}

impl Hits {
    fn new() -> Hits {
        Hits { ev: [Hit::NONE; MAX_EVENTS], len: 0 }
    }

    /// Insert keeping offset order (stable: equal offsets keep arrival order).
    fn push(&mut self, h: Hit) {
        if self.len >= MAX_EVENTS {
            return;
        }
        let mut i = self.len;
        while i > 0 && self.ev[i - 1].offset > h.offset {
            self.ev[i] = self.ev[i - 1];
            i -= 1;
        }
        self.ev[i] = h;
        self.len += 1;
    }

    fn as_slice(&self) -> &[Hit] {
        &self.ev[..self.len]
    }
}

/// Per-track row settings (shared by all of the track's patterns).
#[derive(Clone, Copy)]
pub struct DrumRow {
    pub sample: Option<u32>,
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
}

impl DrumRow {
    pub const fn new() -> DrumRow {
        DrumRow { sample: None, gain: 1.0, pan: 0.0, mute: false }
    }
}

/// One drum pattern: the steps of every row, the step count and the swing
/// (about 1 KB; `MAX_PATTERNS` of them live inline in each track).
#[derive(Clone, Copy)]
pub struct DrumPattern {
    /// `steps[row][step]`: velocity 0..=127; 0 = off. Stored for every step
    /// < MAX_STEPS, even beyond `step_count` (they become audible if the
    /// count grows).
    pub steps: [[u8; MAX_STEPS]; MAX_ROWS],
    pub step_count: usize,
    /// Swing currently placing steps (latched; see module docs).
    pub swing: f32,
    /// Most recent `SetSwing`; becomes `swing` at the next pair boundary.
    pub swing_next: f32,
}

impl DrumPattern {
    /// Empty, 16 steps, no swing.
    pub const fn new() -> DrumPattern {
        DrumPattern { steps: [[0; MAX_STEPS]; MAX_ROWS], step_count: 16, swing: 0.0, swing_next: 0.0 }
    }

    /// Tick of step `k` within the pattern with the latched swing `swing`:
    /// odd steps are pushed late by `swing * 0.5 * STEP_TICKS`.
    fn step_tick(k: usize, swing: f32) -> f64 {
        let late = if k % 2 == 1 { swing as f64 * 0.5 * STEP_TICKS } else { 0.0 };
        k as f64 * STEP_TICKS + late
    }

    /// Add this pattern's steps in the pattern-time window `[lo, hi)` to
    /// `hits` (`origin` = pattern time of frame 0, `spt` samples per tick,
    /// `n` frames), placing them with the latch `swing`, which takes
    /// `swing_next` at every pair boundary the window reaches (R12). Pattern
    /// time is unwrapped (step positions repeat every `step_count` steps);
    /// negative pattern time (the count-in) plays nothing.
    #[allow(clippy::too_many_arguments)]
    fn collect(&self, swing: &mut f32, lo: f64, hi: f64, origin: f64, spt: f64, n: usize, idx: u8, hits: &mut Hits) {
        let count = self.step_count.clamp(1, MAX_STEPS);
        let period = count as f64 * STEP_TICKS; // a multiple of PAIR_TICKS
        let mut offs = [0.0f64; MAX_STEPS];
        // Split the window at step-pair boundaries; each segment uses the
        // swing latched for its pair (R12).
        let mut a = lo;
        while a < hi {
            let next = ((a / PAIR_TICKS).floor() + 1.0) * PAIR_TICKS;
            let b = if next < hi { next } else { hi };
            for (k, o) in offs.iter_mut().enumerate().take(count) {
                *o = Self::step_tick(k, *swing);
            }
            events_in_window(a, b, period, &offs[..count], |step, tick| {
                hits.push(Hit { offset: tick_to_offset(tick, origin, spt, n), step: step as u8, pattern: idx });
            });
            if next <= hi {
                *swing = self.swing_next; // reached a pair boundary
            }
            if next >= hi {
                break;
            }
            a = b;
        }
    }
}

/// One sounding sample. Plays frame 0..end at 1:1 rate. `level` is a
/// linear-ramped declick envelope: it moves by `step` per sample for
/// `ramp_left` samples (step < 0 ends in silence and frees the voice).
#[derive(Clone, Copy)]
pub struct Voice {
    live: bool,
    sample: u32,
    /// Arena region captured at trigger; if the sample slot now points
    /// elsewhere (re-allocated), the voice must not read it.
    slice: Option<SampleSlice>,
    /// Hold-and-fade mode: no data reads; `gl`/`gr` hold the last output and
    /// the `level` ramp takes it to 0.
    hold: bool,
    last_l: f32,
    last_r: f32,
    pos: usize,
    gl: f32,
    gr: f32,
    level: f32,
    step: f32,
    ramp_left: usize,
}

impl Voice {
    const OFF: Voice =
        Voice { live: false, sample: 0, slice: None, hold: false, last_l: 0.0, last_r: 0.0, pos: 0, gl: 0.0, gr: 0.0, level: 0.0, step: 0.0, ramp_left: 0 };

    /// Add this voice into `l`/`r` (equal length). All reads are bounds-checked
    /// against the *current* playable data; running off the end frees the voice.
    fn render_add(&mut self, data: &[f32], frames: usize, channels: u8, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        for i in 0..n {
            let (a, b) = if self.hold {
                (1.0, 1.0) // constant; gl/gr carry the held value
            } else {
                if self.pos >= frames {
                    self.live = false;
                    return;
                }
                let Some(&a) = data.get(self.pos) else {
                    self.live = false;
                    return;
                };
                let b = if channels == 2 { data.get(frames + self.pos).copied().unwrap_or(0.0) } else { a };
                self.pos += 1;
                (a, b)
            };
            self.last_l = a * self.gl * self.level;
            self.last_r = b * self.gr * self.level;
            l[i] += self.last_l;
            r[i] += self.last_r;
            if self.ramp_left > 0 {
                self.level += self.step;
                self.ramp_left -= 1;
                if self.ramp_left == 0 {
                    if self.step < 0.0 {
                        self.level = 0.0;
                        self.live = false;
                        return;
                    }
                    self.level = 1.0;
                }
            }
        }
    }

    #[doc(hidden)]
    pub fn live_for_test(&self) -> bool {
        self.live
    }

    #[doc(hidden)]
    pub fn pos_for_test(&self) -> usize {
        self.pos
    }

    /// Sample data vanished/changed: hold the last output value and ramp it
    /// to 0 over `fade` samples (no data reads, no discontinuity).
    fn begin_hold(&mut self, fade: usize) {
        if self.last_l == 0.0 && self.last_r == 0.0 {
            self.live = false;
            return;
        }
        let fade = fade.max(1);
        self.hold = true;
        self.gl = self.last_l;
        self.gr = self.last_r;
        self.level = 1.0;
        self.step = -1.0 / fade as f32;
        self.ramp_left = fade;
    }

    /// Turn into a fade-out from the current level over `fade` samples.
    fn start_fade_out(&mut self, fade: usize) {
        let fade = fade.max(1);
        self.step = -self.level / fade as f32;
        self.ramp_left = fade;
    }
}

#[derive(Clone, Copy)]
pub struct RowVoices {
    pub active: Voice,
    pub fading: Voice,
}

impl RowVoices {
    const OFF: RowVoices = RowVoices { active: Voice::OFF, fading: Voice::OFF };

    /// Active voice (if any) becomes the fading one.
    fn fade_out(&mut self, fade: usize) {
        if self.active.live {
            self.fading = self.active;
            self.fading.start_fade_out(fade);
            self.active.live = false;
        }
    }

    /// Start a hit. A still-sounding voice fades out (2 ms); the new one starts
    /// at full level (R11: no fade-in, the attack is the sample's own).
    fn trigger(&mut self, sample: u32, slice: Option<SampleSlice>, gl: f32, gr: f32, fade: usize) {
        self.fade_out(fade);
        self.active = Voice {
            live: true,
            sample,
            slice,
            hold: false,
            last_l: 0.0,
            last_r: 0.0,
            pos: 0,
            gl,
            gr,
            level: 1.0,
            step: 0.0,
            ramp_left: 0,
        };
    }

    fn render_add(
        &mut self,
        pool: &SamplePool,
        arena: &SampleArena,
        fade: usize,
        l: &mut [f32],
        r: &mut [f32],
    ) {
        for v in [&mut self.active, &mut self.fading] {
            if !v.live {
                continue;
            }
            if !v.hold {
                let id = v.sample as usize;
                let same = pool.get(id).map(|s| s.slice) == v.slice;
                match pool.playable(arena, id) {
                    Some((data, frames, ch)) if same => {
                        v.render_add(data, frames, ch, l, r);
                        continue;
                    }
                    // Sample replaced / un-readied mid-play: nothing safe to
                    // read, so hold the last value and fade it out.
                    _ => v.begin_hold(fade),
                }
                if !v.live {
                    continue;
                }
            }
            v.render_add(&[], 0, 1, l, r);
        }
    }
}

/// Steps per swing pair; swing changes latch on pair boundaries.
const PAIR_TICKS: f64 = 2.0 * STEP_TICKS;

pub struct DrumTrack {
    pub active: bool,
    /// Index of the pattern that plays and that step / count / swing edits
    /// target (always < MAX_PATTERNS).
    pub current: usize,
    pub patterns: [DrumPattern; MAX_PATTERNS],
    pub rows: [DrumRow; MAX_ROWS],
    pub voices: [RowVoices; MAX_ROWS],
    /// Song mode: the swing latched by clip `i` (see the module docs).
    pub clip_swing: [f32; MAX_CLIPS],
}

impl DrumTrack {
    pub const fn new() -> DrumTrack {
        DrumTrack {
            active: false,
            current: 0,
            patterns: [DrumPattern::new(); MAX_PATTERNS],
            rows: [DrumRow::new(); MAX_ROWS],
            voices: [RowVoices::OFF; MAX_ROWS],
            clip_swing: [0.0; MAX_CLIPS],
        }
    }

    /// Fresh active track: default rows, every pattern empty (16 steps, no
    /// swing), pattern 0 current. Reset in place (no ~17 KB temporary on the
    /// audio thread's stack). Voices are kept (the caller fades them) so a
    /// still-sounding tail is never hard-cut.
    pub fn reset_active(&mut self) {
        self.patterns.fill(DrumPattern::new());
        self.rows.fill(DrumRow::new());
        self.clip_swing.fill(0.0);
        self.current = 0;
        self.active = true;
    }

    pub fn fade_all(&mut self, fade: usize) {
        for v in self.voices.iter_mut() {
            v.fade_out(fade);
        }
    }

    /// The current pattern, mutably.
    pub fn pattern_mut(&mut self) -> &mut DrumPattern {
        // `current` is always < MAX_PATTERNS; fall back to 0 rather than panic.
        let i = if self.current < MAX_PATTERNS { self.current } else { 0 };
        &mut self.patterns[i]
    }
}

pub struct Drums {
    pub tracks: Vec<DrumTrack>,
    /// 2 ms in samples.
    fade: usize,
}

impl Drums {
    pub fn new(sample_rate: f32) -> Drums {
        let mut tracks = Vec::with_capacity(MAX_TRACKS);
        for _ in 0..MAX_TRACKS {
            tracks.push(DrumTrack::new());
        }
        Drums { tracks, fade: ((0.002 * sample_rate as f64).round() as usize).max(1) }
    }

    pub fn fade_samples(&self) -> usize {
        self.fade
    }

    /// Every sounding voice starts its 2 ms fade-out (used by Stop).
    pub fn fade_all(&mut self) {
        let fade = self.fade;
        for t in self.tracks.iter_mut() {
            t.fade_all(fade);
        }
    }

    pub fn add_track(&mut self, slot: usize) {
        let fade = self.fade;
        if let Some(t) = self.tracks.get_mut(slot) {
            t.reset_active();
            t.fade_all(fade);
        }
    }

    pub fn remove_track(&mut self, slot: usize) {
        let fade = self.fade;
        if let Some(t) = self.tracks.get_mut(slot) {
            t.active = false;
            t.fade_all(fade);
        }
    }

    pub fn set_row_mute(&mut self, slot: usize, row: usize, mute: bool) {
        let fade = self.fade;
        if let Some(t) = self.tracks.get_mut(slot) {
            if let Some(r) = t.rows.get_mut(row) {
                r.mute = mute;
            }
            if mute {
                if let Some(v) = t.voices.get_mut(row) {
                    v.fade_out(fade);
                }
            }
        }
    }

    /// Store a new swing in the current pattern. While playing it latches at
    /// the next step-pair boundary (R12); while stopped it applies at once.
    pub fn set_swing(&mut self, slot: usize, swing: f32, playing: bool) {
        if let Some(t) = self.tracks.get_mut(slot) {
            let p = t.pattern_mut();
            p.swing_next = swing;
            if !playing {
                p.swing = swing;
            }
        }
    }

    pub fn row_mut(&mut self, slot: usize, row: usize) -> Option<&mut DrumRow> {
        self.tracks.get_mut(slot)?.rows.get_mut(row)
    }

    /// Velocity of `step` of `row` in the current pattern of track `slot`.
    pub fn step_mut(&mut self, slot: usize, row: usize, step: usize) -> Option<&mut u8> {
        self.tracks.get_mut(slot)?.pattern_mut().steps.get_mut(row)?.get_mut(step)
    }

    /// Step count of the current pattern of track `slot`.
    pub fn set_step_count(&mut self, slot: usize, count: usize) {
        if let Some(t) = self.tracks.get_mut(slot) {
            t.pattern_mut().step_count = count;
        }
    }

    /// Make `pattern` current. Nothing is released (hits ring out on the
    /// row voices) and the swing latch state of both patterns is kept (see
    /// module docs). Out-of-range indices are ignored.
    pub fn set_current(&mut self, slot: usize, pattern: usize) {
        if let Some(t) = self.tracks.get_mut(slot) {
            if pattern < MAX_PATTERNS {
                t.current = pattern;
            }
        }
    }

    /// Copy pattern `from` over pattern `to` (steps, step count, swing).
    /// Copying into the pattern that is playing keeps its latched swing, so
    /// the copied swing latches at the next pair boundary (R12). `from ==
    /// to` and out-of-range indices are no-ops.
    pub fn copy_pattern(&mut self, slot: usize, from: usize, to: usize, playing: bool) {
        let Some(t) = self.tracks.get_mut(slot) else { return };
        if from == to || from >= MAX_PATTERNS || to >= MAX_PATTERNS {
            return;
        }
        let latched = t.patterns[to].swing;
        t.patterns[to] = t.patterns[from]; // ~1 KB memcpy, no allocation
        if playing && to == t.current {
            t.patterns[to].swing = latched;
        }
    }

    /// Turn every step of `pattern` off; its step count and swing stay.
    pub fn clear_pattern(&mut self, slot: usize, pattern: usize) {
        if let Some(p) = self.tracks.get_mut(slot).and_then(|t| t.patterns.get_mut(pattern)) {
            p.steps = [[0; MAX_STEPS]; MAX_ROWS];
        }
    }

    /// Every clip of track `slot` latches its pattern's pending swing now
    /// (a jump of song time: nothing of the new position has played yet).
    pub fn latch_clips(&mut self, slot: usize, clips: &[Clip]) {
        if let Some(t) = self.tracks.get_mut(slot) {
            for (c, s) in clips.iter().zip(t.clip_swing.iter_mut()) {
                if let Some(p) = t.patterns.get(c.pattern as usize) {
                    *s = p.swing_next;
                }
            }
        }
    }

    /// Clip `idx` of track `slot` was set to `clip` and nothing of its new
    /// mapping has played at the playhead (the caller decides; see `ClipSet`
    /// in engine.rs): it latches its pattern's pending swing at once.
    pub fn latch_clip(&mut self, slot: usize, idx: usize, clip: Clip) {
        if let Some(t) = self.tracks.get_mut(slot) {
            if let (Some(s), Some(p)) = (t.clip_swing.get_mut(idx), t.patterns.get(clip.pattern as usize)) {
                *s = p.swing_next;
            }
        }
    }

    /// Add every track's drum output for frames `from..to` of a block (a
    /// Song-mode piece, or the whole block) into its own buffer in
    /// `tracks` (pair = slot). A row that is a sidechain key
    /// (`row_keys[slot][row]` = key slot `k`) renders into key buffer `k`
    /// first and is then added to its track buffer, so the key holds that
    /// row's voices only. `window` is `(t0, t1, samples_per_tick)` while
    /// playing (new hits are scheduled sample-accurately from the current
    /// patterns or the clips, per `timeline`); `None` when stopped, in which
    /// case only tails (fading voices) are rendered. Returns a mask of the
    /// slots that had sounding voices (bit = slot).
    #[allow(clippy::too_many_arguments)]
    pub fn render_add(
        &mut self,
        window: Option<(f64, f64, f64)>,
        timeline: Timeline,
        pool: &SamplePool,
        arena: &SampleArena,
        tracks: &mut StereoBufs,
        keys: &mut StereoBufs,
        row_keys: &[[u8; MAX_ROWS]],
        (from, to): (usize, usize),
    ) -> u32 {
        let n = to.saturating_sub(from);
        let fade = self.fade;
        let mut sounding = 0u32;
        for (slot, track) in self.tracks.iter_mut().enumerate() {
            let mut hits = Hits::new();
            let current = if track.current < MAX_PATTERNS { track.current } else { 0 };
            match (track.active, window, timeline) {
                (true, Some((t0, t1, spt)), Timeline::Pattern) => {
                    let pat = &mut track.patterns[current];
                    let mut swing = pat.swing;
                    pat.collect(&mut swing, t0, t1, t0, spt, n, current as u8, &mut hits);
                    pat.swing = swing;
                }
                (true, Some((t0, t1, spt)), Timeline::Song(_)) => {
                    let DrumTrack { patterns, clip_swing, .. } = track;
                    for_each_overlapping(timeline.clips(slot), t0, t1, |i, c| {
                        let (Some((lo, hi, origin)), Some(pat), Some(swing)) =
                            (c.pattern_window(t0, t1), patterns.get(c.pattern as usize), clip_swing.get_mut(i))
                        else {
                            return;
                        };
                        if (c.start as f64) >= t0 {
                            *swing = pat.swing_next; // starts here: nothing of it played yet
                        }
                        pat.collect(swing, lo, hi, origin, spt, n, c.pattern, &mut hits);
                    });
                }
                // Stopped or inactive: nothing can be scheduled, latch at once.
                _ => {
                    let pat = &mut track.patterns[current];
                    pat.swing = pat.swing_next;
                }
            }
            let DrumTrack { patterns, rows, voices, .. } = track;
            let live = voices.iter().any(|v| v.active.live || v.fading.live);
            if !live && hits.len == 0 {
                continue; // nothing sounds and nothing starts: skip the slot
            }
            let Some((tl, tr)) = tracks.pair_mut(slot, from, to) else { continue };
            sounding |= 1 << slot;
            let keyed = row_keys.get(slot);
            for (ri, (row, rv)) in rows.iter().zip(voices.iter_mut()).enumerate() {
                let key = keyed.and_then(|rk| rk.get(ri)).copied().filter(|&k| (k as usize) < MAX_KEYS);
                match key.and_then(|k| keys.pair_mut(k as usize, from, to)) {
                    Some((kl, kr)) => {
                        render_row(row, rv, ri, patterns, hits.as_slice(), pool, arena, fade, kl, kr);
                        for i in 0..n.min(kl.len()).min(tl.len()) {
                            tl[i] += kl[i];
                            tr[i] += kr[i];
                        }
                    }
                    None => render_row(row, rv, ri, patterns, hits.as_slice(), pool, arena, fade, tl, tr),
                }
            }
        }
        sounding
    }
}

/// Render one row's voices into `l`/`r`, triggering the row's hits (those
/// with a non-zero velocity on row `ri`) at their offsets.
#[allow(clippy::too_many_arguments)]
fn render_row(
    row: &DrumRow,
    rv: &mut RowVoices,
    ri: usize,
    patterns: &[DrumPattern],
    hits: &[Hit],
    pool: &SamplePool,
    arena: &SampleArena,
    fade: usize,
    l: &mut [f32],
    r: &mut [f32],
) {
    let n = l.len().min(r.len());
    let mut pos = 0;
    for h in hits {
        let off = h.offset.min(n);
        let vel = patterns
            .get(h.pattern as usize)
            .and_then(|p| p.steps.get(ri))
            .and_then(|steps| steps.get(h.step as usize))
            .copied()
            .unwrap_or(0);
        if vel == 0 || row.mute {
            continue;
        }
        let Some(id) = row.sample else { continue };
        if pool.playable(arena, id as usize).is_none() {
            continue;
        }
        let at = off.max(pos);
        rv.render_add(pool, arena, fade, &mut l[pos..at], &mut r[pos..at]);
        pos = at;
        let g = row.gain * vel as f32 / 127.0;
        let a = (row.pan + 1.0) * std::f32::consts::FRAC_PI_4;
        rv.trigger(id, pool.get(id as usize).map(|s| s.slice), g * a.cos(), g * a.sin(), fade);
    }
    rv.render_add(pool, arena, fade, &mut l[pos..n], &mut r[pos..n]);
}
