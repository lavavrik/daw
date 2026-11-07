// Meter ballistics on the audio thread (worklet.ts calls applyMeters once per
// block; no allocation).
//
// Why here and not in the UI: the engine writes each block's *instantaneous*
// peak (128 frames, ~2.7 ms). The UI reads the meters once per animation
// frame (~16 ms = ~6 blocks), so a plain copy would show a random block's
// peak: transients between frames are missed and a bass note's meter jumps
// with the waveform phase. Instead the published value is a peak meter with
// instant attack and a linear-in-dB fall of METER_FALL_DB_PER_S: no block
// peak is ever lost, the waveform ripple is tiny, and the fall is still fast
// enough that sidechain pumping and fader moves read clearly.
//
// Layout (MIX_METER_STRIDE = 3 per channel): peak L, peak R (linear, ballistic
// as above), gain reduction in dB (copied as is: the compressor/limiter
// envelope is already smooth).
import { MIX_METER_STRIDE } from './protocol';

/** Peak fall rate of the published meters, dB per second. */
export const METER_FALL_DB_PER_S = 60;
/** Peaks below this (−120 dBFS) are flushed to 0. */
const FLOOR = 1e-6;

/** Per-block linear fall factor for `n`-frame blocks at sample rate `sr`. */
export function meterFall(sr: number, n: number): number {
  return Math.pow(10, (-METER_FALL_DB_PER_S * n) / sr / 20);
}

/** dst[peaks] = max(src, dst * fall) (NaN-safe, tiny -> 0); dst[GR] = src. */
export function applyMeters(dst: Float32Array, src: Float32Array, fall: number): void {
  const n = Math.min(dst.length, src.length);
  for (let k = 0; k < n; k++) {
    const s = src[k];
    if (k % MIX_METER_STRIDE === MIX_METER_STRIDE - 1) {
      dst[k] = s === s ? s : 0;
      continue;
    }
    const prev = dst[k] * fall; // NaN * fall is NaN: fails the > tests below
    let v = s > prev ? s : prev; // NaN s -> prev
    if (!(v >= FLOOR)) v = 0; // NaN and tiny -> 0
    dst[k] = v;
  }
}
