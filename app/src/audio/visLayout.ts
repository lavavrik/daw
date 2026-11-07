// The visual data path's shared memory: the ONE place that computes offsets
// (plan 12; docs/architecture/visuals.md). DOM-free: the worklet imports it.
//
// visSab (created by AudioEngine.start, filled by the worklet's step 4b in
// visCopy.ts, read by the frame loop's consumers):
//
//   Int32Array header, VIS_HDR_LEN i32
//     [0]        want mask, written by the UI (frameLoop.ts): VIS_WANT bits
//                1 master, 2 strip tap, 4 voices, 8 scopes. 0 = copy nothing.
//     [1]        master ring head  } monotonically increasing i32 frame
//     [2]        strip-tap ring head } counts (they wrap at 2^31; compare
//                                      with `(a - b) | 0`)
//     [3]        tapped channel (-1 off), as the engine reported it
//     [4..8)     reserved
//     [8..72)    VIS_SCOPES scope headers of VIS_SCOPE_HDR i32 (Task 2)
//   Float32Arrays, right after the header
//     master ring  L then R, VIS_TAP_RING frames each (the engine output)
//     tap ring     L then R, VIS_TAP_RING frames each (one strip, post-fader)
//     voices       VIS_VOICE_LEN: [(slot*16 + k)*2] level (meter ballistics),
//                  +1 gate
//     scope rings  VIS_SCOPES × VIS_SCOPE_RING × 4 (Task 2)
//   = 288 + 397 312 bytes (about 400 KB).
//
// Ring rule: frame `h` of a ring lives at index `h & (VIS_TAP_RING - 1)` (the
// ring size divides 2^32, so positions stay continuous when the i32 head
// wraps). The writer stores the head with Atomics.store AFTER the data;
// readers Atomics.load it first and never read the oldest VIS_GUARD frames
// (the writer adds at most 128 per block, so a read never meets a write).
// A ring's head only moves while its want bit is set: frames written before
// a consumer turned its bit on may be stale.
//
// The engine side (engine_vis, engine/src/vis.rs) is mirrored in ENGINE_VIS.
import {
  MAX_BLOCK, VIS_SCOPE_HDR, VIS_SCOPE_RING, VIS_SCOPES, VIS_TAP_RING, VIS_VOICE_LEN,
} from './protocol';

/** Want-mask bits (header[0]). */
export const VIS_WANT = { master: 1, tap: 2, voices: 4, scopes: 8 } as const;

/** Readers keep this many frames / entries away from a ring's oldest end. */
export const VIS_GUARD = 256;

/** Header slots (Int32Array indices). */
export const VIS_HDR = { want: 0, masterHead: 1, tapHead: 2, tapCh: 3, scopes: 8 } as const;
/** i32 in the header. */
export const VIS_HDR_LEN = VIS_HDR.scopes + VIS_SCOPES * VIS_SCOPE_HDR;

/** Float32 offsets (in floats, from the end of the header). */
const F = {
  masterL: 0,
  masterR: VIS_TAP_RING,
  tapL: 2 * VIS_TAP_RING,
  tapR: 3 * VIS_TAP_RING,
  voices: 4 * VIS_TAP_RING,
  scopes: 4 * VIS_TAP_RING + VIS_VOICE_LEN,
  len: 4 * VIS_TAP_RING + VIS_VOICE_LEN + VIS_SCOPES * VIS_SCOPE_RING * 4,
} as const;

/** Bytes in visSab. */
export function visBytes(): number {
  return VIS_HDR_LEN * 4 + F.len * 4;
}

/** Live typed views over visSab (AudioEngine.vis(), the worklet). */
export interface VisViews {
  hdr: Int32Array;
  masterL: Float32Array;
  masterR: Float32Array;
  tapL: Float32Array;
  tapR: Float32Array;
  voices: Float32Array;
  /** VIS_SCOPES rings of VIS_SCOPE_RING entries × 4 f32 (Task 2). */
  scopes: Float32Array;
}

/** Views over a visSab of `visBytes()` bytes (allocates: call once). */
export function visViews(sab: SharedArrayBuffer): VisViews {
  const base = VIS_HDR_LEN * 4;
  const f = (at: number, len: number) => new Float32Array(sab, base + at * 4, len);
  return {
    hdr: new Int32Array(sab, 0, VIS_HDR_LEN),
    masterL: f(F.masterL, VIS_TAP_RING),
    masterR: f(F.masterR, VIS_TAP_RING),
    tapL: f(F.tapL, VIS_TAP_RING),
    tapR: f(F.tapR, VIS_TAP_RING),
    voices: f(F.voices, VIS_VOICE_LEN),
    scopes: f(F.scopes, VIS_SCOPES * VIS_SCOPE_RING * 4),
  };
}

/** A fresh visSab: the tap channel reads -1 (off) until the worklet writes. */
export function createVisSab(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(visBytes());
  new Int32Array(sab, 0, VIS_HDR_LEN)[VIS_HDR.tapCh] = -1;
  return sab;
}

/**
 * The engine's visual block (`engine_vis`, engine/src/vis.rs `VIS_*`), in
 * floats: the strip tap (L, R: MAX_BLOCK each, the first `n` of the last
 * block valid), the tapped channel (-1 off), then the voice activity.
 */
export const ENGINE_VIS = {
  tapL: 0,
  tapR: MAX_BLOCK,
  tapCh: 2 * MAX_BLOCK,
  voices: 2 * MAX_BLOCK + 1,
  len: 2 * MAX_BLOCK + 1 + VIS_VOICE_LEN,
} as const;
