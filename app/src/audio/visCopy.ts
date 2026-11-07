// Worklet step 4b (plan 12; docs/architecture/visuals.md): copy this block's
// visual data into visSab, but only what the UI wants. Runs on the audio
// thread once per block: no allocation (plain index loops over views made
// once, never subarray), no blocking, DOM-free (the worklet imports it like
// meterBallistics.ts). With the want mask 0 it writes nothing at all, so a
// hidden UI costs the audio thread one Atomics.load.
//
// Per want bit (VIS_WANT, layout in visLayout.ts):
//   1 master  the n output frames into the master ring, then its head;
//   2 tap     the engine's strip tap (n frames) into the tap ring, the
//             tapped channel, then its head;
//   4 voices  voice levels with the meters' ballistics (instant attack,
//             METER_FALL_DB_PER_S fall, dark below −60 dB like the engine),
//             gates copied as is;
//   8 scopes  per scope slot the engine owns (owner track >= 0): the
//             entries from the slot's mirrored head to the engine's head
//             (at most a ring's worth), then the header fields, then the
//             head (Atomics.store). Free slots copy only the header (the
//             owner reads -1, so no view finds them).
//
// ORDERING RULE: a ring's head is published with Atomics.store only after
// every data write of that ring (and the tap channel) for this block, so a
// reader that Atomics.loads the head first sees complete frames up to it.
import { VIS_HDR, VIS_WANT, ENGINE_VIS, SCOPE_HDR, type EngineScopes, type VisViews } from './visLayout';
import { VIS_SCOPE_HDR, VIS_SCOPE_RING, VIS_SCOPES, VIS_TAP_RING, VIS_VOICE_LEN } from './protocol';

const MASK = VIS_TAP_RING - 1;
/**
 * Voice levels below this (−60 dBFS) flush to 0: the engine's VOICE_FLOOR
 * (engine/src/vis.rs), so a falling LED goes dark at the same level the
 * engine stops reporting a voice.
 */
const FLOOR = 1e-3;

/**
 * Copy `n` frames into ring `l`/`r` at frame `head` (wrapping), from `sl` at
 * `fromL` and `sr` at `fromR`.
 */
function ring(
  l: Float32Array, r: Float32Array, head: number,
  sl: Float32Array, fromL: number, sr: Float32Array, fromR: number, n: number,
): void {
  for (let i = 0; i < n; i++) {
    const at = (head + i) & MASK;
    l[at] = sl[fromL + i];
    r[at] = sr[fromR + i];
  }
}

const SCOPE_MASK = VIS_SCOPE_RING - 1;

/** Want bit 8: every scope slot's new entries, its header, then its head. */
function copyScopes(v: VisViews, es: EngineScopes): void {
  const hdr = v.hdr;
  const src = es.rings;
  const dst = v.scopes;
  const eh = es.hdr;
  for (let s = 0; s < VIS_SCOPES; s++) {
    const eb = s * VIS_SCOPE_HDR;
    const vb = VIS_HDR.scopes + eb;
    const head = eh[eb + SCOPE_HDR.head];
    if (eh[eb + SCOPE_HDR.ownerTrack] >= 0) {
      let from = hdr[vb + SCOPE_HDR.head];
      let count = (head - from) | 0;
      // Far behind (the bit was off) or ahead (never: heads only grow):
      // the last ring's worth.
      if (count < 0 || count > VIS_SCOPE_RING) {
        count = VIS_SCOPE_RING;
        from = (head - VIS_SCOPE_RING) | 0;
      }
      const base = s * VIS_SCOPE_RING * 4;
      for (let i = 0; i < count; i++) {
        const at = base + (((from + i) & SCOPE_MASK) << 2);
        dst[at] = src[at];
        dst[at + 1] = src[at + 1];
        dst[at + 2] = src[at + 2];
        dst[at + 3] = src[at + 3];
      }
    }
    for (let f = 0; f < VIS_SCOPE_HDR; f++) if (f !== SCOPE_HDR.head) hdr[vb + f] = eh[eb + f];
    Atomics.store(hdr, vb + SCOPE_HDR.head, head); // after the entries and fields
  }
}

/**
 * Step 4b. `outL`/`outR`: the engine's output buffers (`n` valid frames);
 * `eng`: the engine's visual block (ENGINE_VIS layout); `fall`: the meters'
 * per-block fall factor (meterFall(sr, n)); `scopes`: the engine's scope
 * bank (want bit 8; omitted = no scopes).
 */
export function copyVis(
  v: VisViews, outL: Float32Array, outR: Float32Array, eng: Float32Array, n: number, fall: number, scopes?: EngineScopes,
): void {
  const hdr = v.hdr;
  const want = Atomics.load(hdr, VIS_HDR.want);
  if (want === 0) return;
  if (want & VIS_WANT.master) {
    const head = hdr[VIS_HDR.masterHead];
    ring(v.masterL, v.masterR, head, outL, 0, outR, 0, n);
    Atomics.store(hdr, VIS_HDR.masterHead, (head + n) | 0); // after the data
  }
  if (want & VIS_WANT.tap) {
    const head = hdr[VIS_HDR.tapHead];
    ring(v.tapL, v.tapR, head, eng, ENGINE_VIS.tapL, eng, ENGINE_VIS.tapR, n);
    Atomics.store(hdr, VIS_HDR.tapCh, eng[ENGINE_VIS.tapCh]);
    Atomics.store(hdr, VIS_HDR.tapHead, (head + n) | 0); // after the data and the channel
  }
  if (want & VIS_WANT.voices) {
    const dst = v.voices;
    const base = ENGINE_VIS.voices;
    for (let k = 0; k < VIS_VOICE_LEN; k += 2) {
      const s = eng[base + k];
      const prev = dst[k] * fall;
      let lv = s > prev && s < Infinity ? s : prev; // NaN / infinite s -> prev
      if (!(lv >= FLOOR)) lv = 0; // NaN and below the floor -> 0
      dst[k] = lv;
      const g = eng[base + k + 1];
      dst[k + 1] = g === g ? g : 0;
    }
  }
  if (want & VIS_WANT.scopes && scopes !== undefined) copyScopes(v, scopes);
}
