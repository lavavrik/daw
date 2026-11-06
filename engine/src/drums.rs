//! Drum tracks: per-track step grids with swing, and declicked sample voices.
//!
//! Everything is fixed-size and preallocated (`Drums::new` is the only place
//! that allocates). Rendering never allocates, blocks or panics.
//!
//! Declicking rules (the project's #1 anti-goal is clicks):
//! * Each row owns two voice slots: `active` and `fading`.
//! * A retrigger over a still-sounding voice crossfades over ~2 ms: the old
//!   voice moves to `fading` and ramps 1 -> 0 while the new voice ramps 0 -> 1.
//!   For steady material the two ramps sum to a constant, so there is no jump.
//!   A trigger over silence starts at full level (the sample's own attack is
//!   the onset; adding a fade-in there would soften every hit).
//! * Stop / mute / track removal move sounding voices to `fading` (2 ms).
//! * Known limit: if a row is retriggered twice within one fade (2 ms), the
//!   older fading voice is dropped. Only reachable at absurd settings.

use crate::arena::{SampleArena, SampleSlice};
use crate::samples::SamplePool;
use crate::transport::{events_in_window, tick_to_offset};
use crate::{MAX_ROWS, MAX_STEPS, MAX_TRACKS, STEP_TICKS};

/// Max step events handled per track per block (a block spans at most a
/// couple of steps at any sane tempo/block size; extras are dropped, not UB).
const MAX_EVENTS: usize = 8;

#[derive(Clone, Copy)]
pub struct DrumRow {
    pub sample: Option<u32>,
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    /// Velocity 0..=127 per step; 0 = off. Stored for every step < MAX_STEPS,
    /// even beyond `step_count` (they become audible if the count grows).
    pub steps: [u8; MAX_STEPS],
}

impl DrumRow {
    pub const fn new() -> DrumRow {
        DrumRow { sample: None, gain: 1.0, pan: 0.0, mute: false, steps: [0; MAX_STEPS] }
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

    fn trigger(&mut self, sample: u32, slice: Option<SampleSlice>, gl: f32, gr: f32, fade: usize) {
        let fade = fade.max(1);
        let crossfade = self.active.live;
        if crossfade {
            self.fade_out(fade);
        }
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
            level: if crossfade { 0.0 } else { 1.0 },
            step: if crossfade { 1.0 / fade as f32 } else { 0.0 },
            ramp_left: if crossfade { fade } else { 0 },
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

pub struct DrumTrack {
    pub active: bool,
    pub step_count: usize,
    pub swing: f32,
    pub rows: [DrumRow; MAX_ROWS],
    pub voices: [RowVoices; MAX_ROWS],
}

impl DrumTrack {
    pub const fn new() -> DrumTrack {
        DrumTrack {
            active: false,
            step_count: 16,
            swing: 0.0,
            rows: [DrumRow::new(); MAX_ROWS],
            voices: [RowVoices::OFF; MAX_ROWS],
        }
    }

    /// Fresh active track: default rows, 16 steps, no swing, silent voices.
    /// Voices are kept (the caller fades them) so a still-sounding tail is
    /// never hard-cut.
    pub fn reset_active(&mut self) {
        let voices = self.voices;
        *self = DrumTrack::new();
        self.voices = voices;
        self.active = true;
    }

    pub fn fade_all(&mut self, fade: usize) {
        for v in self.voices.iter_mut() {
            v.fade_out(fade);
        }
    }

    /// Tick of step `k` within the pattern: odd steps are pushed late by
    /// `swing * 0.5 * STEP_TICKS`.
    fn step_tick(&self, k: usize) -> f64 {
        let late = if k % 2 == 1 { self.swing as f64 * 0.5 * STEP_TICKS } else { 0.0 };
        k as f64 * STEP_TICKS + late
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

    pub fn row_mut(&mut self, slot: usize, row: usize) -> Option<&mut DrumRow> {
        self.tracks.get_mut(slot)?.rows.get_mut(row)
    }

    /// Add all drum output for one block into `l`/`r`. `window` is
    /// `(t0, t1, samples_per_tick)` while playing (new hits are scheduled
    /// sample-accurately); `None` when stopped, in which case only tails
    /// (fading voices) are rendered.
    pub fn render_add(
        &mut self,
        window: Option<(f64, f64, f64)>,
        pool: &SamplePool,
        arena: &SampleArena,
        l: &mut [f32],
        r: &mut [f32],
    ) {
        let n = l.len().min(r.len());
        let fade = self.fade;
        for track in self.tracks.iter_mut() {
            // (sample offset, step index) in time order.
            let mut ev = [(0usize, 0usize); MAX_EVENTS];
            let mut cnt = 0;
            if let (true, Some((t0, t1, spt))) = (track.active, window) {
                let count = track.step_count.clamp(1, MAX_STEPS);
                let mut offs = [0.0f64; MAX_STEPS];
                for (k, o) in offs.iter_mut().enumerate().take(count) {
                    *o = track.step_tick(k);
                }
                events_in_window(t0, t1, count as f64 * STEP_TICKS, &offs[..count], |step, tick| {
                    if cnt < MAX_EVENTS {
                        ev[cnt] = (tick_to_offset(tick, t0, spt, n), step);
                        cnt += 1;
                    }
                });
            }
            for (row, rv) in track.rows.iter().zip(track.voices.iter_mut()) {
                let mut pos = 0;
                for &(off, step) in &ev[..cnt] {
                    let vel = row.steps.get(step).copied().unwrap_or(0);
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
        }
    }
}
