//! Polyphonic sine test tone (8 voices). Used to prove the audio path end to
//! end before the drum machine exists. No allocation: voices are a fixed array.

pub const VOICES: usize = 8;
const ATTACK_SECS: f32 = 0.005;
const RELEASE_SECS: f32 = 0.050;

#[derive(Clone, Copy)]
enum Stage {
    Free,
    Attack,
    Release,
}

#[derive(Clone, Copy)]
struct Voice {
    stage: Stage,
    note: u8,
    phase: f32, // 0..1 cycles
    inc: f32,   // cycles per sample
    env: f32,   // 0..1 linear envelope
    amp: f32,
    order: u64, // allocation counter; smallest = oldest
}

const IDLE: Voice = Voice { stage: Stage::Free, note: 0, phase: 0.0, inc: 0.0, env: 0.0, amp: 0.0, order: 0 };

pub struct TestTone {
    sample_rate: f32,
    voices: [Voice; VOICES],
    counter: u64,
}

impl TestTone {
    pub fn new(sample_rate: f32) -> TestTone {
        TestTone { sample_rate, voices: [IDLE; VOICES], counter: 0 }
    }

    /// Start a voice. Takes a free voice, else steals the oldest one
    /// (restarting its envelope; a short click on a steal is acceptable here).
    pub fn note_on(&mut self, note: u8, vel: u8) {
        let mut pick = 0;
        let mut found_free = false;
        for (i, v) in self.voices.iter().enumerate() {
            if matches!(v.stage, Stage::Free) {
                pick = i;
                found_free = true;
                break;
            }
        }
        if !found_free {
            for (i, v) in self.voices.iter().enumerate() {
                if v.order < self.voices[pick].order {
                    pick = i;
                }
            }
        }
        self.counter += 1;
        let freq = 440.0 * 2f32.powf((note as f32 - 69.0) / 12.0);
        self.voices[pick] = Voice {
            stage: Stage::Attack,
            note,
            phase: 0.0,
            inc: freq / self.sample_rate,
            env: 0.0,
            amp: 0.2 * (vel.min(127) as f32) / 127.0,
            order: self.counter,
        };
    }

    /// Release every held voice playing `note`.
    pub fn note_off(&mut self, note: u8) {
        for v in self.voices.iter_mut() {
            if matches!(v.stage, Stage::Attack) && v.note == note {
                v.stage = Stage::Release;
            }
        }
    }

    /// Number of sounding voices (attack or release).
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| !matches!(v.stage, Stage::Free)).count()
    }

    /// True if a sounding voice is playing `note`.
    pub fn has_note(&self, note: u8) -> bool {
        self.voices.iter().any(|v| !matches!(v.stage, Stage::Free) && v.note == note)
    }

    /// Add the tone into `left`/`right` (mono, same signal both sides).
    pub fn render_add(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len().min(right.len());
        let att = 1.0 / (ATTACK_SECS * self.sample_rate);
        let rel = 1.0 / (RELEASE_SECS * self.sample_rate);
        for v in self.voices.iter_mut() {
            if matches!(v.stage, Stage::Free) {
                continue;
            }
            for i in 0..n {
                match v.stage {
                    Stage::Attack => v.env = (v.env + att).min(1.0),
                    Stage::Release => {
                        v.env -= rel;
                        if v.env <= 0.0 {
                            v.stage = Stage::Free;
                            break;
                        }
                    }
                    Stage::Free => break,
                }
                let s = (v.phase * core::f32::consts::TAU).sin() * v.amp * v.env;
                left[i] += s;
                right[i] += s;
                v.phase += v.inc;
                if v.phase >= 1.0 {
                    v.phase -= 1.0;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ninth_note_steals_oldest() {
        let mut t = TestTone::new(48000.0);
        for n in 60..68 {
            t.note_on(n, 100);
        }
        assert_eq!(t.active_voices(), 8);
        t.note_on(80, 100);
        assert_eq!(t.active_voices(), 8);
        assert!(!t.has_note(60), "oldest voice should be stolen");
        assert!(t.has_note(61) && t.has_note(80));
    }

    #[test]
    fn release_frees_voice() {
        let mut t = TestTone::new(48000.0);
        t.note_on(60, 127);
        t.note_off(60);
        let (mut l, mut r) = ([0.0f32; 1024], [0.0f32; 1024]);
        t.render_add(&mut l, &mut r);
        assert_eq!(t.active_voices(), 0);
    }
}
