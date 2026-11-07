import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyVis } from './visCopy';
import { ENGINE_VIS, VIS_HDR, VIS_WANT, visBytes, visViews, type VisViews } from './visLayout';
import { MAX_BLOCK, VIS_TAP_RING, VIS_VOICE_LEN } from './protocol';
import { meterFall } from './meterBallistics';

const fresh = () => visViews(new SharedArrayBuffer(visBytes()));

/** An engine block (engine_vis) with a tap of `n` frames and channel `ch`. */
function engineBlock(n: number, ch: number, seed = 1): Float32Array {
  const e = new Float32Array(ENGINE_VIS.len);
  for (let i = 0; i < n; i++) {
    e[ENGINE_VIS.tapL + i] = seed + i;
    e[ENGINE_VIS.tapR + i] = -(seed + i);
  }
  e[ENGINE_VIS.tapCh] = ch;
  return e;
}

const out = (n: number, seed: number) => Float32Array.from({ length: n }, (_, i) => seed + i);

afterEach(() => vi.restoreAllMocks());

describe('visCopy (worklet step 4b)', () => {
  it('copies only new frames and wraps', () => {
    const v = fresh();
    v.hdr[VIS_HDR.want] = VIS_WANT.master | VIS_WANT.tap;
    // A head 100 frames before the ring end: 128 frames wrap by 28.
    const start = VIS_TAP_RING * 3 - 100;
    v.hdr[VIS_HDR.masterHead] = start;
    v.hdr[VIS_HDR.tapHead] = start;
    v.masterL.fill(-7);
    copyVis(v, out(128, 1000), out(128, 2000), engineBlock(128, 3), 128, 1);
    expect(v.hdr[VIS_HDR.masterHead]).toBe(start + 128);
    expect(v.hdr[VIS_HDR.tapHead]).toBe(start + 128);
    expect(v.hdr[VIS_HDR.tapCh]).toBe(3);
    for (let i = 0; i < 128; i++) {
      const at = (start + i) & (VIS_TAP_RING - 1);
      expect(v.masterL[at]).toBe(1000 + i);
      expect(v.masterR[at]).toBe(2000 + i);
      expect(v.tapL[at]).toBe(1 + i);
      expect(v.tapR[at]).toBe(-(1 + i));
    }
    // Nothing else was touched: the frames before the old head keep their data.
    const untouched = v.masterL.filter((x) => x === -7).length;
    expect(untouched).toBe(VIS_TAP_RING - 128);

    // Near 2^31 the i32 head wraps negative; positions stay continuous.
    const w = fresh();
    w.hdr[VIS_HDR.want] = VIS_WANT.master;
    const near = 2 ** 31 - 64;
    w.hdr[VIS_HDR.masterHead] = near;
    copyVis(w, out(128, 0), out(128, 0), engineBlock(128, -1), 128, 1);
    expect(w.hdr[VIS_HDR.masterHead]).toBe((near + 128) | 0);
    expect(w.hdr[VIS_HDR.masterHead]).toBeLessThan(0);
    for (let i = 0; i < 128; i++) expect(w.masterL[((near + i) | 0) & (VIS_TAP_RING - 1)]).toBe(i);
    // (a - b) | 0 still measures the distance across the wrap.
    expect((w.hdr[VIS_HDR.masterHead] - near) | 0).toBe(128);
  });

  it('publishes the head after the data', () => {
    const v = fresh();
    v.hdr[VIS_HDR.want] = VIS_WANT.master | VIS_WANT.tap | VIS_WANT.voices;
    const log: string[] = [];
    // A recording proxy over every ring view: each element write is logged.
    const rec = (name: string, a: Float32Array) =>
      new Proxy(a, {
        get(t, k) {
          const x = Reflect.get(t, k, t);
          return typeof x === 'function' ? x.bind(t) : x;
        },
        set(t, k, val) {
          log.push(name);
          return Reflect.set(t, k, val, t);
        },
      });
    const views: VisViews = {
      ...v,
      masterL: rec('master', v.masterL), masterR: rec('master', v.masterR),
      tapL: rec('tap', v.tapL), tapR: rec('tap', v.tapR), voices: rec('voices', v.voices),
    };
    const store = Atomics.store.bind(Atomics) as (a: Int32Array, i: number, x: number) => number;
    const spy = vi.spyOn(Atomics, 'store') as unknown as { mockImplementation(f: (a: Int32Array, i: number, x: number) => number): void };
    spy.mockImplementation((arr, i, val) => {
      log.push(i === VIS_HDR.masterHead ? 'masterHead' : i === VIS_HDR.tapHead ? 'tapHead' : `hdr${i}`);
      return store(arr, i, val);
    });
    copyVis(views, out(128, 1), out(128, 1), engineBlock(128, 0), 128, 1);
    // Each head store comes after every write of its ring, and is the last
    // write for that ring.
    const lastData = (n: string) => log.lastIndexOf(n);
    expect(log.indexOf('masterHead')).toBeGreaterThan(lastData('master'));
    expect(log.indexOf('tapHead')).toBeGreaterThan(lastData('tap'));
    expect(log.filter((x) => x === 'masterHead')).toHaveLength(1);
    expect(log.filter((x) => x === 'tapHead')).toHaveLength(1);
    // The tap channel lands before the tap head too.
    expect(log.indexOf('hdr3')).toBeGreaterThan(lastData('tap'));
    expect(log.indexOf('hdr3')).toBeLessThan(log.indexOf('tapHead'));
  });

  it('skips what nobody wants', () => {
    const v = fresh();
    const before = new Uint8Array(v.hdr.buffer).slice();
    const store = vi.spyOn(Atomics, 'store');
    copyVis(v, out(128, 1), out(128, 1), engineBlock(128, 5), 128, 0.5);
    expect(store).not.toHaveBeenCalled();
    expect(new Uint8Array(v.hdr.buffer)).toEqual(before);
    // Wanting only the voices copies no ring.
    v.hdr[VIS_HDR.want] = VIS_WANT.voices;
    copyVis(v, out(128, 1), out(128, 1), engineBlock(128, 5), 128, 0.5);
    expect(v.hdr[VIS_HDR.masterHead]).toBe(0);
    expect(v.hdr[VIS_HDR.tapHead]).toBe(0);
    expect(v.masterL.every((x) => x === 0) && v.tapL.every((x) => x === 0)).toBe(true);
  });

  it('voice levels fall like meters and gates copy as is', () => {
    const v = fresh();
    v.hdr[VIS_HDR.want] = VIS_WANT.voices;
    const fall = meterFall(48000, 128);
    const e = engineBlock(0, -1);
    const V = ENGINE_VIS.voices;
    e[V + 0] = 0.5; // voice 0 level
    e[V + 1] = 1; // voice 0 gate
    e[V + 2] = 0.25;
    e[V + 3] = 0;
    e[V + VIS_VOICE_LEN - 2] = 0.75; // the last voice of the last slot
    copyVis(v, out(128, 0), out(128, 0), e, 128, fall);
    expect([v.voices[0], v.voices[1], v.voices[2], v.voices[3]]).toEqual([0.5, 1, 0.25, 0]);
    expect(v.voices[VIS_VOICE_LEN - 2]).toBe(0.75);
    // The note ends: the level falls at the meters' rate, the gate drops at once.
    e[V + 0] = 0;
    e[V + 1] = 0;
    copyVis(v, out(128, 0), out(128, 0), e, 128, fall);
    expect(v.voices[0]).toBeCloseTo(0.5 * fall, 7);
    expect(v.voices[1]).toBe(0);
    // A new peak above the falling value takes over at once.
    e[V + 2] = 0.9;
    copyVis(v, out(128, 0), out(128, 0), e, 128, fall);
    expect(v.voices[2]).toBeCloseTo(0.9, 7);
    // Tiny levels flush to 0.
    for (let i = 0; i < 2000; i++) copyVis(v, out(128, 0), out(128, 0), engineBlock(0, -1), 128, fall);
    expect(v.voices.every((x) => x === 0)).toBe(true);
  });

  it('voice levels use the engine floor (-60 dB) and ignore non-finite input', () => {
    const v = fresh();
    v.hdr[VIS_HDR.want] = VIS_WANT.voices;
    const e = engineBlock(0, -1);
    const V = ENGINE_VIS.voices;
    e[V + 0] = 2e-3; // above -60 dB: shown
    e[V + 2] = 5e-4; // below: 0, as the engine's VOICE_FLOOR
    e[V + 4] = Infinity;
    e[V + 6] = NaN;
    copyVis(v, out(128, 0), out(128, 0), e, 128, 0.999);
    expect([v.voices[0], v.voices[2], v.voices[4], v.voices[6]]).toEqual([Math.fround(2e-3), 0, 0, 0]);
    // A held level is not wiped by a later non-finite value: it falls.
    e[V + 0] = Infinity;
    copyVis(v, out(128, 0), out(128, 0), e, 128, 0.999);
    expect(v.voices[0]).toBeCloseTo(2e-3 * 0.999, 9);
    // Below the floor while falling: 0.
    e[V + 0] = 0;
    for (let i = 0; i < 1000; i++) copyVis(v, out(128, 0), out(128, 0), e, 128, 0.999);
    expect(v.voices[0]).toBe(0);
  });

  it('the layout fits the plan (about 400 KB) and the engine block mirrors vis.rs', () => {
    expect(visBytes()).toBeGreaterThan(390_000);
    expect(visBytes()).toBeLessThan(410_000);
    expect(ENGINE_VIS).toEqual({ tapL: 0, tapR: MAX_BLOCK, tapCh: 2 * MAX_BLOCK, voices: 2 * MAX_BLOCK + 1, len: 2 * MAX_BLOCK + 1 + VIS_VOICE_LEN });
  });
});
