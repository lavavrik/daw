//! Command protocol: UI -> engine. Every record is `[op, a, b, c, d]` (f64).
//!
//! `decode` runs on the audio thread and must NEVER panic: a WASM trap kills
//! audio permanently. All float->int conversions are range-checked first, and
//! NaN/Inf fail every range comparison, so they are rejected.
//!
//! A later TS parity test regex-parses the constants below, so each is on its
//! own line in the form `pub const NAME: u32|i32 = N;`.

use crate::arrangement::Clip;
use crate::mixer::catalog;
use crate::mixer::Key;
use crate::rack::catalog::ModuleKind;
use crate::sequencer::{SeqNote, MAX_NOTE_TICKS};
use crate::{
    BAR_TICKS, MAX_CLIPS, MAX_MODULES, MAX_NOTES, MAX_PARAMS, MAX_PATTERNS, MAX_PATTERN_BARS, MAX_PORTS, MAX_ROWS, MAX_SAMPLES, MAX_STEPS,
    MAX_SONG_TICKS, MAX_TRACKS, MIX_CHANNELS,
};

/// Ports per module in the packed `module * PORT_STRIDE + port` encoding.
pub const PORT_STRIDE: usize = 16;

pub const OP_NOTE_ON: u32 = 1; // a=note, b=velocity
pub const OP_NOTE_OFF: u32 = 2; // a=note
pub const OP_PLAY: u32 = 3; // a=count-in ticks: 0 or 3840 (one bar)
pub const OP_STOP: u32 = 4;
pub const OP_SET_TEMPO: u32 = 5; // a=bpm 20..=300
pub const OP_SET_METRONOME: u32 = 6; // a=0/1
pub const OP_ADD_DRUM_TRACK: u32 = 7; // a=slot (activates rows 0..MAX_ROWS, empty)
pub const OP_REMOVE_TRACK: u32 = 8; // a=slot
pub const OP_SET_ROW_SAMPLE: u32 = 9; // a=slot b=row c=sample id or -1
pub const OP_SET_ROW_GAIN: u32 = 10; // a=slot b=row c=gain 0..2
pub const OP_SET_ROW_PAN: u32 = 11; // a=slot b=row c=pan -1..1
pub const OP_SET_ROW_MUTE: u32 = 12; // a=slot b=row c=0/1
pub const OP_SET_STEP: u32 = 13; // a=slot b=row c=step d=velocity 0..127 (0 = off)
pub const OP_SET_STEP_COUNT: u32 = 14; // a=slot b=16|32|64
pub const OP_SET_SWING: u32 = 15; // a=slot b=0..1
pub const OP_SET_MASTER_GAIN: u32 = 16; // a=0..2
// Synth tracks and rack edits. Ports are packed into one argument as
// `module * 16 + port` (module < MAX_MODULES, port < MAX_PORTS).
pub const OP_ADD_SYNTH_TRACK: u32 = 17; // a=slot (empty patch)
pub const OP_RACK_ADD_MODULE: u32 = 18; // a=slot b=module idx c=kind id
pub const OP_RACK_REMOVE_MODULE: u32 = 19; // a=slot b=module idx
pub const OP_RACK_CONNECT: u32 = 20; // a=slot b=from (packed output) c=to (packed input)
pub const OP_RACK_DISCONNECT: u32 = 21; // a=slot b=to (packed input)
pub const OP_RACK_SET_PARAM: u32 = 22; // a=slot b=module c=param d=value
pub const OP_RACK_CLEAR: u32 = 23; // a=slot
// Live input: notes/controllers go to the input track's rack.
pub const OP_SET_INPUT_TRACK: u32 = 24; // a=slot or -1 (none)
pub const OP_PITCH_BEND: u32 = 25; // a=-1..1
pub const OP_MOD_WHEEL: u32 = 26; // a=0..1
pub const OP_SUSTAIN: u32 = 27; // a=0/1
// Synth note patterns (sequencer.rs). A note is addressed as
// `slot * MAX_NOTES + idx`; pitch and velocity are packed as `pitch * 128 + vel`.
pub const OP_NOTE_SET: u32 = 28; // a=slot*MAX_NOTES+idx b=pitch*128+vel c=start ticks d=length ticks
pub const OP_NOTE_REMOVE: u32 = 29; // a=slot*MAX_NOTES+idx
pub const OP_NOTE_CLEAR: u32 = 30; // a=slot
pub const OP_SET_PATTERN_BARS: u32 = 31; // a=slot b=1..16
// Patterns: every drum/synth track holds MAX_PATTERNS patterns; step, swing,
// step-count, note and bars edits act on the track's *current* pattern.
pub const OP_SET_CURRENT_PATTERN: u32 = 32; // a=slot b=pattern 0..MAX_PATTERNS-1
pub const OP_COPY_PATTERN: u32 = 33; // a=slot b=from c=to (pattern data within one track)
pub const OP_CLEAR_PATTERN_DATA: u32 = 34; // a=slot b=pattern (steps/notes; keeps lengths and swing)
// Song timeline (arrangement.rs). A clip is addressed as `slot * MAX_CLIPS +
// idx`; its pattern and offset are packed as `offset * 16 + pattern`.
pub const OP_CLIP_SET: u32 = 35; // a=slot*MAX_CLIPS+idx b=offset*16+pattern c=start ticks d=length ticks
pub const OP_CLIP_REMOVE: u32 = 36; // a=slot*MAX_CLIPS+idx
pub const OP_CLIP_CLEAR: u32 = 37; // a=slot
pub const OP_SET_MODE: u32 = 38; // a=0 pattern / 1 song
pub const OP_SET_LOOP: u32 = 39; // a=start ticks b=end ticks (b <= a disables the loop)
pub const OP_SEEK: u32 = 40; // a=song ticks (Song mode; ignored in Pattern mode)
// Mixer (mixer/mod.rs). Channels: 0..31 tracks, 32 Reverb return, 33 Delay
// return, 34 master. Params and their ranges: mixer/catalog.rs.
pub const OP_MIX_SET: u32 = 41; // a=channel 0..34 b=param id c=value (catalog range; flags 0/1)
pub const OP_MIX_SET_KEY: u32 = 42; // a=track channel 0..31 b=key: -1 none, slot*32 track, slot*32+row+1 drum row
pub const OP_MIX_RESET: u32 = 43; // a=channel 0..34: every param to its default, key none

pub const OK: i32 = 0;
pub const ERR_UNKNOWN_OP: i32 = -1;
pub const ERR_BAD_INDEX: i32 = -2;
pub const ERR_BAD_VALUE: i32 = -3;
pub const ERR_DEFERRED: i32 = -4;
/// Sample alloc only: growing the arena failed (WASM memory at its max).
pub const ERR_OUT_OF_MEMORY: i32 = -5;

/// A decoded, range-checked command. Indices are guaranteed in range for
/// their tables; rack-level checks (module present, port in its spec, param
/// value in its spec range) are done by the rack itself.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    /// Start with the transport at `-count_in` ticks (0 or one bar).
    Play { count_in: f64 },
    Stop,
    SetTempo { bpm: f32 },
    SetMetronome { on: bool },
    AddDrumTrack { slot: usize },
    RemoveTrack { slot: usize },
    SetRowSample { slot: usize, row: usize, sample: Option<u32> },
    SetRowGain { slot: usize, row: usize, gain: f32 },
    SetRowPan { slot: usize, row: usize, pan: f32 },
    SetRowMute { slot: usize, row: usize, mute: bool },
    SetStep { slot: usize, row: usize, step: usize, velocity: u8 },
    SetStepCount { slot: usize, count: usize },
    SetSwing { slot: usize, swing: f32 },
    SetMasterGain { gain: f32 },
    AddSynthTrack { slot: usize },
    RackAddModule { slot: usize, module: usize, kind: ModuleKind },
    RackRemoveModule { slot: usize, module: usize },
    /// `from` = (module, output port), `to` = (module, input port).
    RackConnect { slot: usize, from: (usize, usize), to: (usize, usize) },
    RackDisconnect { slot: usize, to: (usize, usize) },
    RackSetParam { slot: usize, module: usize, param: usize, value: f32 },
    RackClear { slot: usize },
    /// `None` = no input track (live notes are ignored).
    SetInputTrack { slot: Option<usize> },
    PitchBend { value: f32 },
    ModWheel { value: f32 },
    Sustain { on: bool },
    /// Store `note` (always `active`) in pattern slot `idx` of synth track `slot`.
    NoteSet { slot: usize, idx: usize, note: SeqNote },
    NoteRemove { slot: usize, idx: usize },
    NoteClear { slot: usize },
    /// Pattern length, 1..=`MAX_PATTERN_BARS` bars.
    SetPatternBars { slot: usize, bars: u8 },
    /// Make `pattern` the one the track plays and edits.
    SetCurrentPattern { slot: usize, pattern: usize },
    /// Copy pattern `from` over pattern `to` within one track (`from == to`: no-op).
    CopyPattern { slot: usize, from: usize, to: usize },
    /// Clear the steps / notes of `pattern`, keeping its length and swing.
    ClearPatternData { slot: usize, pattern: usize },
    /// Store `clip` (always `active`) in clip slot `idx` of track `slot`.
    ClipSet { slot: usize, idx: usize, clip: Clip },
    ClipRemove { slot: usize, idx: usize },
    ClipClear { slot: usize },
    /// `true` = Song mode (the arrangement plays), `false` = Pattern mode.
    SetMode { song: bool },
    /// Loop range in song ticks; on only while `start < end`.
    SetLoop { start: u32, end: u32 },
    /// Move the song playhead (Song mode only).
    Seek { ticks: u32 },
    /// Set mixer param `param` (a catalog id the channel accepts) to `value`
    /// (in the catalog range; integral for integer params).
    MixSet { channel: usize, param: u32, value: f32 },
    /// Sidechain key of track channel `channel` (the engine checks that the
    /// source exists and, for a row, is a drum track).
    MixSetKey { channel: usize, key: Key },
    /// Every param of `channel` to its default (and its key to none).
    MixReset { channel: usize },
}

/// Finite, integral, in `0..max` -> index; otherwise `ERR_BAD_INDEX`.
fn index(v: f64, max: usize) -> Result<usize, i32> {
    if v.is_finite() && v.fract() == 0.0 && v >= 0.0 && v < max as f64 {
        Ok(v as usize)
    } else {
        Err(ERR_BAD_INDEX)
    }
}

/// Finite float within `lo..=hi`; otherwise `ERR_BAD_VALUE`.
fn ranged(v: f64, lo: f64, hi: f64) -> Result<f32, i32> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(v as f32)
    } else {
        Err(ERR_BAD_VALUE)
    }
}

/// Integral value in `0..=127` (MIDI note / velocity).
fn midi7(v: f64) -> Result<u8, i32> {
    if v.is_finite() && v.fract() == 0.0 && (0.0..=127.0).contains(&v) {
        Ok(v as u8)
    } else {
        Err(ERR_BAD_VALUE)
    }
}

/// Exactly 0 or 1.
fn flag(v: f64) -> Result<bool, i32> {
    if v == 0.0 {
        Ok(false)
    } else if v == 1.0 {
        Ok(true)
    } else {
        Err(ERR_BAD_VALUE)
    }
}

/// Sample id: -1 (none) or an integral id in `0..MAX_SAMPLES`.
/// It indexes the sample table, so failures are `ERR_BAD_INDEX`.
fn sample_id(v: f64) -> Result<Option<u32>, i32> {
    if v == -1.0 {
        Ok(None)
    } else {
        index(v, MAX_SAMPLES).map(|i| Some(i as u32))
    }
}

/// Module kind wire id: integral and known to the catalog; otherwise
/// `ERR_BAD_INDEX` (it indexes the catalog).
fn kind_id(v: f64) -> Result<ModuleKind, i32> {
    if v.is_finite() && v.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&v) {
        ModuleKind::from_id(v as u32).ok_or(ERR_BAD_INDEX)
    } else {
        Err(ERR_BAD_INDEX)
    }
}

/// Packed `module * PORT_STRIDE + port` -> `(module, port)`, with
/// `module < MAX_MODULES` and `port < MAX_PORTS`; otherwise `ERR_BAD_INDEX`.
fn packed_port(v: f64) -> Result<(usize, usize), i32> {
    let i = index(v, MAX_MODULES * PORT_STRIDE)?;
    let (module, port) = (i / PORT_STRIDE, i % PORT_STRIDE);
    if port < MAX_PORTS {
        Ok((module, port))
    } else {
        Err(ERR_BAD_INDEX)
    }
}

/// Any finite value (the rack range-checks it against the param spec;
/// values beyond f32 become ±Inf there and are rejected as `ERR_BAD_VALUE`).
fn finite(v: f64) -> Result<f32, i32> {
    if v.is_finite() {
        Ok(v as f32)
    } else {
        Err(ERR_BAD_VALUE)
    }
}

/// Integral value in `lo..=hi`; otherwise `ERR_BAD_VALUE`.
fn int_in(v: f64, lo: u32, hi: u32) -> Result<u32, i32> {
    if v.is_finite() && v.fract() == 0.0 && v >= lo as f64 && v <= hi as f64 {
        Ok(v as u32)
    } else {
        Err(ERR_BAD_VALUE)
    }
}

/// Packed note address `slot * MAX_NOTES + idx` -> `(slot, idx)`; anything
/// non-integral or out of range is `ERR_BAD_INDEX`.
fn note_addr(v: f64) -> Result<(usize, usize), i32> {
    let i = index(v, MAX_TRACKS * MAX_NOTES)?;
    Ok((i / MAX_NOTES, i % MAX_NOTES))
}

/// A note from packed `pitch * 128 + vel` (pitch 0..=127, vel 1..=127), start
/// `0..MAX_NOTE_TICKS` and length `1..=MAX_NOTE_TICKS`; else `ERR_BAD_VALUE`.
fn seq_note(pv: f64, start: f64, len: f64) -> Result<SeqNote, i32> {
    let pv = int_in(pv, 0, 128 * 128 - 1)?;
    let (pitch, vel) = ((pv / 128) as u8, (pv % 128) as u8);
    if vel == 0 {
        return Err(ERR_BAD_VALUE);
    }
    Ok(SeqNote {
        active: true,
        pitch,
        vel,
        start: int_in(start, 0, MAX_NOTE_TICKS - 1)?,
        len: int_in(len, 1, MAX_NOTE_TICKS)?,
    })
}

/// Packed clip address `slot * MAX_CLIPS + idx` -> `(slot, idx)`; anything
/// non-integral or out of range is `ERR_BAD_INDEX`.
fn clip_addr(v: f64) -> Result<(usize, usize), i32> {
    let i = index(v, MAX_TRACKS * MAX_CLIPS)?;
    Ok((i / MAX_CLIPS, i % MAX_CLIPS))
}

/// A clip from packed `offset * 16 + pattern` (offset `0..MAX_NOTE_TICKS`),
/// start and length (integral, `len >= 1`, `start + len <= MAX_SONG_TICKS`);
/// else `ERR_BAD_VALUE`.
fn clip(op: f64, start: f64, len: f64) -> Result<Clip, i32> {
    let op = int_in(op, 0, MAX_NOTE_TICKS * MAX_PATTERNS as u32 - 1)?;
    let song = MAX_SONG_TICKS as u32;
    let start = int_in(start, 0, song - 1)?;
    let len = int_in(len, 1, song - start)?;
    Ok(Clip {
        active: true,
        pattern: (op % MAX_PATTERNS as u32) as u8,
        start,
        len,
        offset: op / MAX_PATTERNS as u32,
    })
}

/// Sidechain key code: −1 is none, `slot * 32` is track `slot` and
/// `slot * 32 + row + 1` is drum row `row` of track `slot` (row < MAX_ROWS).
/// Anything else is `ERR_BAD_VALUE`.
fn key_code(v: f64) -> Result<Key, i32> {
    if v == -1.0 {
        return Ok(Key::None);
    }
    let code = int_in(v, 0, (MAX_TRACKS * 32 - 1) as u32)? as usize;
    match (code / 32, code % 32) {
        (slot, 0) => Ok(Key::Track(slot)),
        (slot, r) if r <= MAX_ROWS => Ok(Key::Row(slot, r - 1)),
        _ => Err(ERR_BAD_VALUE),
    }
}

/// `OP_MIX_SET`: the param must exist (`ERR_BAD_INDEX`) and apply to the
/// channel (`ERR_BAD_INDEX`); the value must be valid for it (`ERR_BAD_VALUE`).
fn mix_set(a: f64, b: f64, c: f64) -> Result<Command, i32> {
    let channel = index(a, MIX_CHANNELS)?;
    let id = index(b, catalog::MIX_PARAMS)? as u32;
    let p = catalog::param(id).ok_or(ERR_BAD_INDEX)?;
    if !p.accepts(channel) {
        return Err(ERR_BAD_INDEX);
    }
    if !p.valid(c) {
        return Err(ERR_BAD_VALUE);
    }
    Ok(Command::MixSet { channel, param: id, value: c as f32 })
}

/// Decode and range-check one record. Never panics.
pub fn decode(op: u32, a: f64, b: f64, c: f64, d: f64) -> Result<Command, i32> {
    Ok(match op {
        OP_NOTE_ON => Command::NoteOn { note: midi7(a)?, velocity: midi7(b)? },
        OP_NOTE_OFF => Command::NoteOff { note: midi7(a)? },
        OP_PLAY => Command::Play {
            count_in: if a == 0.0 || a == BAR_TICKS {
                a.abs() // -0.0 -> 0.0
            } else {
                return Err(ERR_BAD_VALUE);
            },
        },
        OP_STOP => Command::Stop,
        OP_SET_TEMPO => Command::SetTempo { bpm: ranged(a, 20.0, 300.0)? },
        OP_SET_METRONOME => Command::SetMetronome { on: flag(a)? },
        OP_ADD_DRUM_TRACK => Command::AddDrumTrack { slot: index(a, MAX_TRACKS)? },
        OP_REMOVE_TRACK => Command::RemoveTrack { slot: index(a, MAX_TRACKS)? },
        OP_SET_ROW_SAMPLE => Command::SetRowSample {
            slot: index(a, MAX_TRACKS)?,
            row: index(b, MAX_ROWS)?,
            sample: sample_id(c)?,
        },
        OP_SET_ROW_GAIN => Command::SetRowGain {
            slot: index(a, MAX_TRACKS)?,
            row: index(b, MAX_ROWS)?,
            gain: ranged(c, 0.0, 2.0)?,
        },
        OP_SET_ROW_PAN => Command::SetRowPan {
            slot: index(a, MAX_TRACKS)?,
            row: index(b, MAX_ROWS)?,
            pan: ranged(c, -1.0, 1.0)?,
        },
        OP_SET_ROW_MUTE => Command::SetRowMute {
            slot: index(a, MAX_TRACKS)?,
            row: index(b, MAX_ROWS)?,
            mute: flag(c)?,
        },
        OP_SET_STEP => Command::SetStep {
            slot: index(a, MAX_TRACKS)?,
            row: index(b, MAX_ROWS)?,
            step: index(c, MAX_STEPS)?,
            velocity: midi7(d)?,
        },
        OP_SET_STEP_COUNT => Command::SetStepCount {
            slot: index(a, MAX_TRACKS)?,
            count: if b == 16.0 || b == 32.0 || b == 64.0 {
                b as usize
            } else {
                return Err(ERR_BAD_VALUE);
            },
        },
        OP_SET_SWING => Command::SetSwing { slot: index(a, MAX_TRACKS)?, swing: ranged(b, 0.0, 1.0)? },
        OP_SET_MASTER_GAIN => Command::SetMasterGain { gain: ranged(a, 0.0, 2.0)? },
        OP_ADD_SYNTH_TRACK => Command::AddSynthTrack { slot: index(a, MAX_TRACKS)? },
        OP_RACK_ADD_MODULE => Command::RackAddModule {
            slot: index(a, MAX_TRACKS)?,
            module: index(b, MAX_MODULES)?,
            kind: kind_id(c)?,
        },
        OP_RACK_REMOVE_MODULE => {
            Command::RackRemoveModule { slot: index(a, MAX_TRACKS)?, module: index(b, MAX_MODULES)? }
        }
        OP_RACK_CONNECT => {
            Command::RackConnect { slot: index(a, MAX_TRACKS)?, from: packed_port(b)?, to: packed_port(c)? }
        }
        OP_RACK_DISCONNECT => Command::RackDisconnect { slot: index(a, MAX_TRACKS)?, to: packed_port(b)? },
        OP_RACK_SET_PARAM => Command::RackSetParam {
            slot: index(a, MAX_TRACKS)?,
            module: index(b, MAX_MODULES)?,
            param: index(c, MAX_PARAMS)?,
            value: finite(d)?,
        },
        OP_RACK_CLEAR => Command::RackClear { slot: index(a, MAX_TRACKS)? },
        OP_SET_INPUT_TRACK => Command::SetInputTrack {
            slot: if a == -1.0 { None } else { Some(index(a, MAX_TRACKS)?) },
        },
        OP_PITCH_BEND => Command::PitchBend { value: ranged(a, -1.0, 1.0)? },
        OP_MOD_WHEEL => Command::ModWheel { value: ranged(a, 0.0, 1.0)? },
        OP_SUSTAIN => Command::Sustain { on: flag(a)? },
        OP_NOTE_SET => {
            let (slot, idx) = note_addr(a)?;
            Command::NoteSet { slot, idx, note: seq_note(b, c, d)? }
        }
        OP_NOTE_REMOVE => {
            let (slot, idx) = note_addr(a)?;
            Command::NoteRemove { slot, idx }
        }
        OP_NOTE_CLEAR => Command::NoteClear { slot: index(a, MAX_TRACKS)? },
        OP_SET_PATTERN_BARS => Command::SetPatternBars {
            slot: index(a, MAX_TRACKS)?,
            bars: int_in(b, 1, MAX_PATTERN_BARS as u32)? as u8,
        },
        // A pattern number indexes the track's pattern table: ERR_BAD_INDEX.
        OP_SET_CURRENT_PATTERN => {
            Command::SetCurrentPattern { slot: index(a, MAX_TRACKS)?, pattern: index(b, MAX_PATTERNS)? }
        }
        OP_COPY_PATTERN => Command::CopyPattern {
            slot: index(a, MAX_TRACKS)?,
            from: index(b, MAX_PATTERNS)?,
            to: index(c, MAX_PATTERNS)?,
        },
        OP_CLEAR_PATTERN_DATA => {
            Command::ClearPatternData { slot: index(a, MAX_TRACKS)?, pattern: index(b, MAX_PATTERNS)? }
        }
        OP_CLIP_SET => {
            let (slot, idx) = clip_addr(a)?;
            Command::ClipSet { slot, idx, clip: clip(b, c, d)? }
        }
        OP_CLIP_REMOVE => {
            let (slot, idx) = clip_addr(a)?;
            Command::ClipRemove { slot, idx }
        }
        OP_CLIP_CLEAR => Command::ClipClear { slot: index(a, MAX_TRACKS)? },
        OP_SET_MODE => Command::SetMode { song: flag(a)? },
        OP_SET_LOOP => {
            let song = MAX_SONG_TICKS as u32;
            Command::SetLoop { start: int_in(a, 0, song)?, end: int_in(b, 0, song)? }
        }
        OP_SEEK => Command::Seek { ticks: int_in(a, 0, MAX_SONG_TICKS as u32)? },
        OP_MIX_SET => mix_set(a, b, c)?,
        OP_MIX_SET_KEY => Command::MixSetKey { channel: index(a, MAX_TRACKS)?, key: key_code(b)? },
        OP_MIX_RESET => Command::MixReset { channel: index(a, MIX_CHANNELS)? },
        _ => return Err(ERR_UNKNOWN_OP),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_set_step_ok() {
        assert_eq!(
            decode(13, 1., 2., 3., 100.),
            Ok(Command::SetStep { slot: 1, row: 2, step: 3, velocity: 100 })
        );
    }
    #[test]
    fn decode_rejects_unknown_op() {
        assert_eq!(decode(999, 0., 0., 0., 0.), Err(ERR_UNKNOWN_OP));
    }
    #[test]
    fn decode_rejects_out_of_range_index() {
        assert_eq!(decode(OP_ADD_DRUM_TRACK, 32., 0., 0., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_SET_ROW_GAIN, 0., 16., 1., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_SET_STEP, 0., 0., 64., 1.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_REMOVE_TRACK, -1., 0., 0., 0.), Err(ERR_BAD_INDEX));
    }
    #[test]
    fn decode_rejects_non_finite() {
        assert_eq!(decode(OP_SET_TEMPO, f64::NAN, 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_ROW_GAIN, 0., 0., f64::INFINITY, 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_REMOVE_TRACK, f64::NAN, 0., 0., 0.), Err(ERR_BAD_INDEX));
    }
    #[test]
    fn decode_rejects_tempo_out_of_range() {
        assert_eq!(decode(OP_SET_TEMPO, 19.9, 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_TEMPO, 300.1, 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_TEMPO, 124., 0., 0., 0.), Ok(Command::SetTempo { bpm: 124.0 }));
    }
    #[test]
    fn decode_rejects_bad_step_count() {
        assert_eq!(decode(OP_SET_STEP_COUNT, 0., 17., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_STEP_COUNT, 0., 32., 0., 0.), Ok(Command::SetStepCount { slot: 0, count: 32 }));
    }
    #[test]
    fn decode_sample_minus_one_is_none() {
        assert_eq!(
            decode(OP_SET_ROW_SAMPLE, 0., 1., -1., 0.),
            Ok(Command::SetRowSample { slot: 0, row: 1, sample: None })
        );
        assert_eq!(
            decode(OP_SET_ROW_SAMPLE, 0., 1., 5., 0.),
            Ok(Command::SetRowSample { slot: 0, row: 1, sample: Some(5) })
        );
        assert_eq!(decode(OP_SET_ROW_SAMPLE, 0., 1., 256., 0.), Err(ERR_BAD_INDEX));
    }
    #[test]
    fn decode_never_panics_on_garbage() {
        let vals = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1e300, 1e300, 0.5, -0.0, 3e9, -3e9];
        for op in 0..48u32 {
            for &v in &vals {
                let _ = decode(op, v, v, v, v);
            }
        }
        let _ = decode(u32::MAX, 0., 0., 0., 0.);
    }
    #[test]
    fn decode_rack_commands() {
        use crate::rack::catalog::ModuleKind;
        assert_eq!(decode(OP_ADD_SYNTH_TRACK, 3., 0., 0., 0.), Ok(Command::AddSynthTrack { slot: 3 }));
        assert_eq!(
            decode(OP_RACK_ADD_MODULE, 3., 31., 8., 0.),
            Ok(Command::RackAddModule { slot: 3, module: 31, kind: ModuleKind::Out })
        );
        assert_eq!(decode(OP_RACK_ADD_MODULE, 3., 0., 9., 0.), Err(ERR_BAD_INDEX), "unknown kind");
        assert_eq!(decode(OP_RACK_ADD_MODULE, 3., 32., 1., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_RACK_REMOVE_MODULE, 3., 4., 0., 0.), Ok(Command::RackRemoveModule { slot: 3, module: 4 }));
        // Ports are packed module*16 + port.
        assert_eq!(
            decode(OP_RACK_CONNECT, 0., 2. * 16. + 1., 5. * 16. + 7., 0.),
            Ok(Command::RackConnect { slot: 0, from: (2, 1), to: (5, 7) })
        );
        assert_eq!(decode(OP_RACK_CONNECT, 0., 8., 16., 0.), Err(ERR_BAD_INDEX), "port 8 >= MAX_PORTS");
        assert_eq!(decode(OP_RACK_CONNECT, 0., 0., 32. * 16., 0.), Err(ERR_BAD_INDEX), "module 32");
        assert_eq!(decode(OP_RACK_DISCONNECT, 0., 17., 0., 0.), Ok(Command::RackDisconnect { slot: 0, to: (1, 1) }));
        assert_eq!(
            decode(OP_RACK_SET_PARAM, 0., 1., 2., 0.25),
            Ok(Command::RackSetParam { slot: 0, module: 1, param: 2, value: 0.25 })
        );
        assert_eq!(decode(OP_RACK_SET_PARAM, 0., 1., 12., 0.25), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_RACK_SET_PARAM, 0., 1., 2., f64::NAN), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_RACK_CLEAR, 31., 0., 0., 0.), Ok(Command::RackClear { slot: 31 }));
        assert_eq!(decode(OP_SET_INPUT_TRACK, -1., 0., 0., 0.), Ok(Command::SetInputTrack { slot: None }));
        assert_eq!(decode(OP_SET_INPUT_TRACK, 4., 0., 0., 0.), Ok(Command::SetInputTrack { slot: Some(4) }));
        assert_eq!(decode(OP_SET_INPUT_TRACK, -2., 0., 0., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_PITCH_BEND, -1., 0., 0., 0.), Ok(Command::PitchBend { value: -1.0 }));
        assert_eq!(decode(OP_PITCH_BEND, 1.01, 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_MOD_WHEEL, 1., 0., 0., 0.), Ok(Command::ModWheel { value: 1.0 }));
        assert_eq!(decode(OP_SUSTAIN, 1., 0., 0., 0.), Ok(Command::Sustain { on: true }));
        assert_eq!(decode(OP_SUSTAIN, 0.5, 0., 0., 0.), Err(ERR_BAD_VALUE));
    }
    #[test]
    fn decode_play_count_in() {
        assert_eq!(decode(OP_PLAY, 0., 0., 0., 0.), Ok(Command::Play { count_in: 0.0 }));
        assert_eq!(decode(OP_PLAY, 3840., 0., 0., 0.), Ok(Command::Play { count_in: 3840.0 }));
        for bad in [1.0, -3840.0, 960.0, 7680.0, 3840.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_PLAY, bad, 0., 0., 0.), Err(ERR_BAD_VALUE), "{bad}");
        }
    }
    #[test]
    fn decode_note_commands() {
        let n = |pitch, vel, start, len| SeqNote { active: true, pitch, vel, start, len };
        let a = 3. * 1024. + 1023.;
        assert_eq!(
            decode(OP_NOTE_SET, a, 60. * 128. + 100., 960., 480.),
            Ok(Command::NoteSet { slot: 3, idx: 1023, note: n(60, 100, 960, 480) })
        );
        assert_eq!(
            decode(OP_NOTE_SET, 0., 127. * 128. + 127., 61439., 61440.),
            Ok(Command::NoteSet { slot: 0, idx: 0, note: n(127, 127, 61439, 61440) })
        );
        for bad_a in [-1., 32. * 1024., 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_NOTE_SET, bad_a, 60. * 128. + 1., 0., 1.), Err(ERR_BAD_INDEX), "a {bad_a}");
            assert_eq!(decode(OP_NOTE_REMOVE, bad_a, 0., 0., 0.), Err(ERR_BAD_INDEX), "a {bad_a}");
        }
        for (b, c, d) in [
            (128. * 128., 0., 1.),       // pitch 128
            (60. * 128., 0., 1.),        // velocity 0
            (60. * 128. + 0.5, 0., 1.),  // fractional
            (-1., 0., 1.),
            (f64::NAN, 0., 1.),
            (61., 61440., 1.),           // start past the last tick
            (61., -1., 1.),
            (61., 0.5, 1.),
            (61., 0., 0.),               // length 0
            (61., 0., 61441.),
            (61., 0., 1.5),
            (61., 0., f64::INFINITY),
        ] {
            assert_eq!(decode(OP_NOTE_SET, 0., b, c, d), Err(ERR_BAD_VALUE), "{b} {c} {d}");
        }
        assert_eq!(decode(OP_NOTE_REMOVE, 1025., 0., 0., 0.), Ok(Command::NoteRemove { slot: 1, idx: 1 }));
        assert_eq!(decode(OP_NOTE_CLEAR, 31., 0., 0., 0.), Ok(Command::NoteClear { slot: 31 }));
        assert_eq!(decode(OP_NOTE_CLEAR, 32., 0., 0., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_SET_PATTERN_BARS, 2., 16., 0., 0.), Ok(Command::SetPatternBars { slot: 2, bars: 16 }));
        assert_eq!(decode(OP_SET_PATTERN_BARS, 2., 1., 0., 0.), Ok(Command::SetPatternBars { slot: 2, bars: 1 }));
        for bad in [0., 17., 1.5, -1., f64::NAN] {
            assert_eq!(decode(OP_SET_PATTERN_BARS, 2., bad, 0., 0.), Err(ERR_BAD_VALUE), "bars {bad}");
        }
        assert_eq!(decode(OP_SET_PATTERN_BARS, 32., 4., 0., 0.), Err(ERR_BAD_INDEX));
    }
    #[test]
    fn decode_pattern_commands() {
        assert_eq!(
            decode(OP_SET_CURRENT_PATTERN, 31., 15., 0., 0.),
            Ok(Command::SetCurrentPattern { slot: 31, pattern: 15 })
        );
        assert_eq!(decode(OP_COPY_PATTERN, 2., 0., 15., 0.), Ok(Command::CopyPattern { slot: 2, from: 0, to: 15 }));
        assert_eq!(decode(OP_COPY_PATTERN, 2., 4., 4., 0.), Ok(Command::CopyPattern { slot: 2, from: 4, to: 4 }));
        assert_eq!(decode(OP_CLEAR_PATTERN_DATA, 0., 7., 0., 0.), Ok(Command::ClearPatternData { slot: 0, pattern: 7 }));
        for bad in [16., -1., 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_SET_CURRENT_PATTERN, 0., bad, 0., 0.), Err(ERR_BAD_INDEX), "{bad}");
            assert_eq!(decode(OP_CLEAR_PATTERN_DATA, 0., bad, 0., 0.), Err(ERR_BAD_INDEX), "{bad}");
            assert_eq!(decode(OP_COPY_PATTERN, 0., bad, 0., 0.), Err(ERR_BAD_INDEX), "from {bad}");
            assert_eq!(decode(OP_COPY_PATTERN, 0., 0., bad, 0.), Err(ERR_BAD_INDEX), "to {bad}");
            for op in [OP_SET_CURRENT_PATTERN, OP_COPY_PATTERN, OP_CLEAR_PATTERN_DATA] {
                let slot = if bad == 16. { 32. } else { bad };
                assert_eq!(decode(op, slot, 0., 0., 0.), Err(ERR_BAD_INDEX), "op {op} slot {slot}");
            }
        }
    }
    #[test]
    fn decode_song_commands() {
        let c = |pattern, start, len, offset| Clip { active: true, pattern, start, len, offset };
        let song = MAX_SONG_TICKS as f64;
        let a = 3. * 256. + 255.;
        assert_eq!(
            decode(OP_CLIP_SET, a, 1920. * 16. + 15., 7680., 9600.),
            Ok(Command::ClipSet { slot: 3, idx: 255, clip: c(15, 7680, 9600, 1920) })
        );
        assert_eq!(
            decode(OP_CLIP_SET, 0., 61439. * 16., song - 1., 1.),
            Ok(Command::ClipSet { slot: 0, idx: 0, clip: c(0, MAX_SONG_TICKS as u32 - 1, 1, 61439) })
        );
        assert_eq!(
            decode(OP_CLIP_SET, 0., 0., 0., song),
            Ok(Command::ClipSet { slot: 0, idx: 0, clip: c(0, 0, MAX_SONG_TICKS as u32, 0) })
        );
        for bad_a in [-1., 32. * 256., 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_CLIP_SET, bad_a, 0., 0., 1.), Err(ERR_BAD_INDEX), "a {bad_a}");
            assert_eq!(decode(OP_CLIP_REMOVE, bad_a, 0., 0., 0.), Err(ERR_BAD_INDEX), "a {bad_a}");
        }
        for (b, cc, d) in [
            (61440. * 16., 0., 1.),  // offset 61440
            (-1., 0., 1.),
            (0.5, 0., 1.),
            (f64::NAN, 0., 1.),
            (0., -1., 1.),
            (0., 0.5, 1.),
            (0., song, 1.),          // starts at the song end
            (0., 0., 0.),            // length 0
            (0., 0., 1.5),
            (0., 1., song),          // start + len past the song end
            (0., song - 10., 11.),
            (0., 0., f64::INFINITY),
        ] {
            assert_eq!(decode(OP_CLIP_SET, 0., b, cc, d), Err(ERR_BAD_VALUE), "{b} {cc} {d}");
        }
        assert_eq!(decode(OP_CLIP_REMOVE, 257., 0., 0., 0.), Ok(Command::ClipRemove { slot: 1, idx: 1 }));
        assert_eq!(decode(OP_CLIP_CLEAR, 31., 0., 0., 0.), Ok(Command::ClipClear { slot: 31 }));
        assert_eq!(decode(OP_CLIP_CLEAR, 32., 0., 0., 0.), Err(ERR_BAD_INDEX));
        assert_eq!(decode(OP_SET_MODE, 1., 0., 0., 0.), Ok(Command::SetMode { song: true }));
        assert_eq!(decode(OP_SET_MODE, 0., 0., 0., 0.), Ok(Command::SetMode { song: false }));
        assert_eq!(decode(OP_SET_MODE, 2., 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_LOOP, 3840., 11520., 0., 0.), Ok(Command::SetLoop { start: 3840, end: 11520 }));
        assert_eq!(decode(OP_SET_LOOP, 5., 0., 0., 0.), Ok(Command::SetLoop { start: 5, end: 0 }), "off");
        assert_eq!(decode(OP_SET_LOOP, 0., song, 0., 0.), Ok(Command::SetLoop { start: 0, end: song as u32 }));
        assert_eq!(decode(OP_SEEK, song, 0., 0., 0.), Ok(Command::Seek { ticks: song as u32 }));
        for bad in [-1., song + 1., 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_SET_LOOP, bad, 0., 0., 0.), Err(ERR_BAD_VALUE), "{bad}");
            assert_eq!(decode(OP_SET_LOOP, 0., bad, 0., 0.), Err(ERR_BAD_VALUE), "{bad}");
            assert_eq!(decode(OP_SEEK, bad, 0., 0., 0.), Err(ERR_BAD_VALUE), "{bad}");
        }
    }
    #[test]
    fn decode_mix_commands() {
        use crate::mixer::catalog::*;
        assert_eq!(decode(OP_MIX_SET, 3., P_FADER as f64, -6., 0.), Ok(Command::MixSet { channel: 3, param: P_FADER, value: -6.0 }));
        assert_eq!(decode(OP_MIX_SET, 34., P_LIMITER_CEILING as f64, -6., 0.), Ok(Command::MixSet { channel: 34, param: 29, value: -6.0 }));
        assert_eq!(decode(OP_MIX_SET, 32., P_REV_DECAY as f64, 20., 0.), Ok(Command::MixSet { channel: 32, param: 22, value: 20.0 }));
        assert_eq!(decode(OP_MIX_SET, 33., P_DELAY_TIME as f64, 11., 0.), Ok(Command::MixSet { channel: 33, param: 25, value: 11.0 }));
        // Channel, param id and channel kind are indices; values are values.
        for (a, b) in [(35., 0.), (-1., 0.), (0.5, 0.), (f64::NAN, 0.), (0., 30.), (0., -1.), (0., 0.5), (0., f64::INFINITY)] {
            assert_eq!(decode(OP_MIX_SET, a, b, 0., 0.), Err(ERR_BAD_INDEX), "{a} {b}");
        }
        for (a, b) in [(34., P_PAN), (34., P_COMP_ON), (32., P_SOLO), (32., P_DELAY_TIME), (33., P_REV_SIZE), (0., P_LIMITER_CEILING), (0., P_REV_SIZE)] {
            assert_eq!(decode(OP_MIX_SET, a, b as f64, 0., 0.), Err(ERR_BAD_INDEX), "channel {a} param {b}");
        }
        for (b, c) in [(P_FADER, 6.5), (P_FADER, -61.), (P_FADER, f64::NAN), (P_MUTE, 0.5), (P_MUTE, 2.), (P_PAN, 1.01), (P_EQ_HP, 19.), (P_COMP_RATIO, 0.5), (P_DELAY_TIME, 12.), (P_DELAY_TIME, 1.5)] {
            let ch = if b == P_DELAY_TIME { 33. } else { 0. };
            assert_eq!(decode(OP_MIX_SET, ch, b as f64, c, 0.), Err(ERR_BAD_VALUE), "param {b} value {c}");
        }
        assert_eq!(decode(OP_MIX_SET_KEY, 5., -1., 0., 0.), Ok(Command::MixSetKey { channel: 5, key: Key::None }));
        assert_eq!(decode(OP_MIX_SET_KEY, 5., 2. * 32., 0., 0.), Ok(Command::MixSetKey { channel: 5, key: Key::Track(2) }));
        assert_eq!(decode(OP_MIX_SET_KEY, 5., 2. * 32. + 1., 0., 0.), Ok(Command::MixSetKey { channel: 5, key: Key::Row(2, 0) }));
        assert_eq!(decode(OP_MIX_SET_KEY, 0., 31. * 32. + 16., 0., 0.), Ok(Command::MixSetKey { channel: 0, key: Key::Row(31, 15) }));
        for bad in [-2., 2. * 32. + 17., 2. * 32. + 31., 32. * 32., 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(decode(OP_MIX_SET_KEY, 5., bad, 0., 0.), Err(ERR_BAD_VALUE), "key {bad}");
        }
        for bad in [32., 34., -1., 0.5] {
            assert_eq!(decode(OP_MIX_SET_KEY, bad, -1., 0., 0.), Err(ERR_BAD_INDEX), "channel {bad}");
        }
        assert_eq!(decode(OP_MIX_RESET, 34., 0., 0., 0.), Ok(Command::MixReset { channel: 34 }));
        assert_eq!(decode(OP_MIX_RESET, 35., 0., 0., 0.), Err(ERR_BAD_INDEX));
    }
    #[test]
    fn decode_value_ranges() {
        assert_eq!(decode(OP_SET_ROW_GAIN, 0., 0., 2.1, 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_ROW_PAN, 0., 0., -1.1, 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_SWING, 0., 1.1, 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_MASTER_GAIN, 2.5, 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_STEP, 0., 0., 0., 128.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_NOTE_ON, 128., 100., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_METRONOME, 2., 0., 0., 0.), Err(ERR_BAD_VALUE));
        assert_eq!(decode(OP_SET_ROW_MUTE, 0., 0., 1., 0.), Ok(Command::SetRowMute { slot: 0, row: 0, mute: true }));
    }
}
