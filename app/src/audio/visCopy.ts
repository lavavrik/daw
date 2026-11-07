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
//   8 scopes  Task 2.
//
// ORDERING RULE: a ring's head is published with Atomics.store only after
// every data write of that ring (and the tap channel) for this block, so a
// reader that Atomics.loads the head first sees complete frames up to it.
import { VIS_HDR, VIS_WANT, ENGINE_VIS, type VisViews } from './visLayout';
import { VIS_TAP_RING, VIS_VOICE_LEN } from './protocol';

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

/**
 * Step 4b. `outL`/`outR`: the engine's output buffers (`n` valid frames);
 * `eng`: the engine's visual block (ENGINE_VIS layout); `fall`: the meters'
 * per-block fall factor (meterFall(sr, n)).
 */
export function copyVis(v: VisViews, outL: Float32Array, outR: Float32Array, eng: Float32Array, n: number, fall: number): void {
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
}
