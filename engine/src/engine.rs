//! Engine core: owns all state, decodes commands, renders blocks.
//! `process` is the real-time callback: no allocation, no blocking, no panics.

use crate::protocol::{self, Command};
use crate::test_tone::TestTone;
use crate::MAX_BLOCK;

pub struct Engine {
    tone: TestTone,
    master_gain: f32,
    telemetry: [f64; 8],
    // Later tasks add: transport, drum tracks, sample arena.
}

impl Engine {
    /// Does all big allocations (none yet; later tasks reserve the arena here).
    pub fn new(sample_rate: f32) -> Engine {
        Engine { tone: TestTone::new(sample_rate), master_gain: 0.8, telemetry: [0.0; 8] }
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
            // Accepted and ignored until later tasks wire them.
            _ => {}
        }
    }

    /// Render one block, overwriting both buffers. Frames beyond
    /// `MAX_BLOCK` or beyond the shorter buffer are zeroed, never panicking.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        let n = left.len().min(right.len()).min(MAX_BLOCK);
        self.tone.render_add(&mut left[..n], &mut right[..n]);
        let (mut pl, mut pr) = (0.0f32, 0.0f32);
        for i in 0..n {
            let l = (left[i] * self.master_gain).clamp(-1.0, 1.0);
            let r = (right[i] * self.master_gain).clamp(-1.0, 1.0);
            left[i] = l;
            right[i] = r;
            pl = pl.max(l.abs());
            pr = pr.max(r.abs());
        }
        self.telemetry[0] += 1.0;
        self.telemetry[5] = pl as f64;
        self.telemetry[6] = pr as f64;
    }

    pub fn telemetry(&self) -> &[f64; 8] {
        &self.telemetry
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{OP_NOTE_OFF, OP_NOTE_ON};

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
}
