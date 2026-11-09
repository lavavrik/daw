//! The engine's mirror of the scale maths the note modules need (plan 26
//! Task 3): the scales, nearest in-key pitch, the diatonic seventh and the
//! chord voicings of the Chord module.
//!
//! The one source is `app/src/music/scales.ts` (docs/architecture/theory.md);
//! this file copies only what the Chord module uses. The JSON fixture
//! `engine/tests/fixtures/scales.json` (generated from scales.ts by
//! `app/src/music/scales.fixture.test.ts`) pins the parity: the test below
//! checks the tables and every one of its voicing and nearest rows. Change
//! scales.ts -> regenerate the fixture -> this test says what to follow.
//!
//! Wire order: a scale index is a position in [`SCALES`] (`SET_KEY` b), a
//! chord type a position in [`CHORDS`] (the Chord module's `type` param);
//! both lists are append-only, like scales.ts `SCALE_IDS` / `CHORD_TYPES`.
//!
//! Pure and allocation-free (fixed arrays).

/// Scale intervals (semitones above the root), in wire order: major, minor,
/// dorian, mixolydian, harmonic minor, minor pentatonic, major pentatonic,
/// chromatic.
pub const SCALES: [&[u8]; 8] = [
    &[0, 2, 4, 5, 7, 9, 11],
    &[0, 2, 3, 5, 7, 8, 10],
    &[0, 2, 3, 5, 7, 9, 10],
    &[0, 2, 4, 5, 7, 9, 10],
    &[0, 2, 3, 5, 7, 8, 11],
    &[0, 3, 5, 7, 10],
    &[0, 2, 4, 7, 9],
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
];

/// The 7-note scale each scale's chords are stacked in (scales.ts
/// `harmony`): itself, the parent of a pentatonic, major for chromatic.
pub const HARMONY: [usize; 8] = [0, 1, 2, 3, 4, 1, 0, 0];

const CHROMATIC: usize = 7;

/// Chord type intervals in wire order (maj, min, 7, maj7, m7, m9, sus2,
/// sus4, dim); index [`IN_KEY`] (`None`) follows the key.
pub const CHORDS: [Option<&[u8]>; 10] = [
    Some(&[0, 4, 7]),
    Some(&[0, 3, 7]),
    Some(&[0, 4, 7, 10]),
    Some(&[0, 4, 7, 11]),
    Some(&[0, 3, 7, 10]),
    Some(&[0, 3, 7, 10, 14]),
    Some(&[0, 2, 7]),
    Some(&[0, 5, 7]),
    Some(&[0, 3, 6]),
    None,
];

/// The "In key" chord type: the diatonic seventh of the root's degree.
pub const IN_KEY: usize = 9;

/// The most notes a chord has (m9).
pub const MAX_CHORD: usize = 5;

/// The highest inversion (scales.ts `MAX_INVERSION`).
pub const MAX_INVERSION: usize = 3;

/// The song's key: root pitch class 0..11 (C = 0) and a scale index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub root: u8,
    pub scale: u8,
}

/// A minor, the project default (scales.ts `DEFAULT_KEY`).
pub const DEFAULT_KEY: Key = Key { root: 9, scale: 1 };

impl Key {
    /// A key from wire values (`None` unless root 0..11 and a known scale).
    pub fn new(root: usize, scale: usize) -> Option<Key> {
        (root < 12 && scale < SCALES.len()).then_some(Key { root: root as u8, scale: scale as u8 })
    }

    fn intervals(self) -> &'static [u8] {
        SCALES[(self.scale as usize).min(SCALES.len() - 1)]
    }

    /// The same root in this key's harmony scale.
    fn harmony(self) -> Key {
        Key { root: self.root, scale: HARMONY[(self.scale as usize).min(HARMONY.len() - 1)] as u8 }
    }
}

fn pitch_class(p: i32) -> u8 {
    p.rem_euclid(12) as u8
}

/// Is `pitch` in `key`'s scale?
pub fn in_key(pitch: i32, key: Key) -> bool {
    key.intervals().contains(&pitch_class(pitch - key.root as i32))
}

/// 0-based degree of `pitch` in `key`'s scale, or `None`.
fn degree(pitch: i32, key: Key) -> Option<usize> {
    let pc = pitch_class(pitch - key.root as i32);
    key.intervals().iter().position(|&i| i == pc)
}

/// The in-key pitch nearest `pitch`, inside 0..127, a tie going up
/// (scales.ts `nearestInKey` without `dir`). `pitch` is clamped first.
pub fn nearest_in_key(pitch: i32, key: Key) -> i32 {
    let p = pitch.clamp(0, 127);
    if in_key(p, key) {
        return p;
    }
    for d in 1..=127 {
        if p + d <= 127 && in_key(p + d, key) {
            return p + d;
        }
        if p - d >= 0 && in_key(p - d, key) {
            return p - d;
        }
    }
    p
}

/// The diatonic seventh on `degree` (0..6) of `key`'s harmony scale, as
/// semitones above that degree's note (scales.ts `diatonicChord`, seventh).
fn diatonic_seventh(key: Key, degree: usize) -> [u8; 4] {
    let iv = key.harmony().intervals();
    let n = iv.len();
    let d = degree % n;
    let at = |i: usize| iv[i % n] as i32 + 12 * (i / n) as i32;
    let mut out = [0u8; 4];
    for (o, s) in out.iter_mut().zip([0, 2, 4, 6]) {
        *o = (at(d + s) - iv[d] as i32) as u8;
    }
    out
}

/// The root an In key chord is built on: `root_pitch` snapped to the key's
/// own scale (a pentatonic key snaps to its pentatonic notes), ties up; a
/// chromatic key snaps to its harmony (major) scale, the only one it has
/// chords in. Either way the result is in the harmony scale.
fn in_key_root(root_pitch: i32, key: Key) -> i32 {
    let snap = if key.scale as usize == CHROMATIC { key.harmony() } else { key };
    nearest_in_key(root_pitch, snap)
}

/// The chord's MIDI pitches for chord type `ty` (index into [`CHORDS`]) on
/// `root_pitch` at `inversion` (clamped to 0..=MAX_INVERSION; moves the
/// lowest `min(inversion, n-1)` notes up an octave), ascending, pitches
/// outside 0..127 dropped (scales.ts `voiceChord`). Writes `out` and returns
/// how many. An unknown type plays the root alone.
pub fn voice_chord(root_pitch: i32, ty: usize, inversion: usize, key: Key, out: &mut [u8; MAX_CHORD]) -> usize {
    let mut notes = [0i32; MAX_CHORD];
    let n = match CHORDS.get(ty) {
        Some(Some(iv)) => {
            for (o, &i) in notes.iter_mut().zip(iv.iter()) {
                *o = root_pitch + i as i32;
            }
            iv.len().min(MAX_CHORD)
        }
        Some(None) => {
            let root = in_key_root(root_pitch, key);
            let d = degree(root, key.harmony()).unwrap_or(0);
            for (o, i) in notes.iter_mut().zip(diatonic_seventh(key, d)) {
                *o = root + i as i32;
            }
            4
        }
        None => {
            notes[0] = root_pitch;
            1
        }
    };
    let inv = inversion.min(MAX_INVERSION).min(n - 1);
    for x in notes.iter_mut().take(inv) {
        *x += 12;
    }
    let notes = &mut notes[..n];
    notes.sort_unstable();
    let mut k = 0;
    for &p in notes.iter() {
        if (0..=127).contains(&p) {
            out[k] = p as u8;
            k += 1;
        }
    }
    k
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_json::value;

    fn fixture() -> crate::test_json::J {
        value(include_bytes!("../../../tests/fixtures/scales.json"), &mut 0)
    }

    fn nums(j: &crate::test_json::J) -> Vec<i32> {
        j.arr().iter().map(|x| x.num() as i32).collect()
    }

    #[test]
    fn tables_match_fixture() {
        let doc = fixture();
        let scales = doc.get("scales").arr();
        assert_eq!(scales.len(), SCALES.len(), "scale count (append both sides)");
        for (i, s) in scales.iter().enumerate() {
            assert_eq!(s.get("index").num() as usize, i);
            let want: Vec<u8> = nums(s.get("intervals")).iter().map(|&x| x as u8).collect();
            assert_eq!(SCALES[i], &want[..], "scale {}", s.get("id").str());
            assert_eq!(HARMONY[i], s.get("harmony").num() as usize, "harmony of {}", s.get("id").str());
        }
        let chords = doc.get("chords").arr();
        assert_eq!(chords.len(), CHORDS.len(), "chord type count (append both sides)");
        for (i, c) in chords.iter().enumerate() {
            assert_eq!(c.get("index").num() as usize, i);
            let iv = c.get("intervals");
            match CHORDS[i] {
                None => {
                    assert!(iv.is_null(), "{} follows the key", c.get("id").str());
                    assert_eq!(i, IN_KEY);
                }
                Some(want) => {
                    let got: Vec<u8> = nums(iv).iter().map(|&x| x as u8).collect();
                    assert_eq!(want, &got[..], "chord {}", c.get("id").str());
                }
            }
        }
        assert!(CHORDS.iter().flatten().all(|c| c.len() <= MAX_CHORD));
    }

    #[test]
    fn nearest_matches_fixture() {
        for set in fixture().get("nearest").arr() {
            let key = Key::new(set.get("root").num() as usize, set.get("scale").num() as usize).unwrap();
            for row in set.get("rows").arr() {
                let r = nums(row);
                assert_eq!(nearest_in_key(r[0], key), r[1], "pitch {} in {key:?}", r[0]);
            }
        }
    }

    #[test]
    fn diatonic_sevenths_match_fixture() {
        for set in fixture().get("diatonic").arr() {
            let key = Key::new(0, set.get("scale").num() as usize).unwrap();
            for (d, deg) in set.get("degrees").arr().iter().enumerate() {
                let want: Vec<u8> = nums(deg.get("seventh")).iter().map(|&x| x as u8).collect();
                assert_eq!(diatonic_seventh(key, d).to_vec(), want, "{key:?} degree {d}");
            }
        }
    }

    #[test]
    fn voicings_match_fixture() {
        let rows = fixture().get("voicings").arr().to_vec();
        assert!(rows.len() >= 1000, "the fixture covers every type x inversion x key");
        for row in rows {
            let r = row.arr();
            let (root, ty, inv) = (r[0].num() as i32, r[1].num() as usize, r[2].num() as usize);
            let key = Key::new(r[3].num() as usize, r[4].num() as usize).unwrap();
            let want: Vec<u8> = nums(&r[5]).iter().map(|&x| x as u8).collect();
            let mut out = [0u8; MAX_CHORD];
            let n = voice_chord(root, ty, inv, key, &mut out);
            assert_eq!(out[..n].to_vec(), want, "root {root} type {ty} inv {inv} {key:?}");
        }
    }

    #[test]
    fn a_minor_in_key_on_a3_is_am7() {
        let mut out = [0u8; MAX_CHORD];
        let n = voice_chord(57, IN_KEY, 0, DEFAULT_KEY, &mut out);
        assert_eq!(&out[..n], &[57, 60, 64, 67]);
        assert_eq!(Key::new(12, 0), None);
        assert_eq!(Key::new(0, 8), None);
    }
}
