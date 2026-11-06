//! Command protocol: UI -> engine. Every record is `[op, a, b, c, d]` (f64).
//!
//! `decode` runs on the audio thread and must NEVER panic: a WASM trap kills
//! audio permanently. All float->int conversions are range-checked first, and
//! NaN/Inf fail every range comparison, so they are rejected.
//!
//! A later TS parity test regex-parses the constants below, so each is on its
//! own line in the form `pub const NAME: u32|i32 = N;`.

use crate::{MAX_ROWS, MAX_SAMPLES, MAX_STEPS, MAX_TRACKS};

pub const OP_NOTE_ON: u32 = 1; // a=note, b=velocity
pub const OP_NOTE_OFF: u32 = 2; // a=note
pub const OP_PLAY: u32 = 3;
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

pub const OK: i32 = 0;
pub const ERR_UNKNOWN_OP: i32 = -1;
pub const ERR_BAD_INDEX: i32 = -2;
pub const ERR_BAD_VALUE: i32 = -3;
pub const ERR_DEFERRED: i32 = -4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Command {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    Play,
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

pub fn decode(op: u32, a: f64, b: f64, c: f64, d: f64) -> Result<Command, i32> {
    Ok(match op {
        OP_NOTE_ON => Command::NoteOn { note: midi7(a)?, velocity: midi7(b)? },
        OP_NOTE_OFF => Command::NoteOff { note: midi7(a)? },
        OP_PLAY => Command::Play,
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
        for op in 0..40u32 {
            for &v in &vals {
                let _ = decode(op, v, v, v, v);
            }
        }
        let _ = decode(u32::MAX, 0., 0., 0., 0.);
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
