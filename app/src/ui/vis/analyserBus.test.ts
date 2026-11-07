import { describe, expect, it } from 'vitest';
import { createAnalyserBus, type AnalyserNeed } from './analyserBus';
import { createFrameLoop, type FrameEnv } from './frameLoop';
import { VIS_HDR, VIS_WANT, visBytes, visViews, type VisViews } from '../../audio/visLayout';
import { VIS_TAP_RING } from '../../audio/protocol';
import { DB_FLOOR } from './spectrum';

/** The real frame loop on a fake rAF / clock / document (no IntersectionObserver needed: views have no el). */
function rig() {
  let t = 0;
  let id = 1;
  const pending = new Map<number, (now: number) => void>();
  const env: FrameEnv = {
    raf: (fn) => (pending.set(id, fn), id++),
    caf: (i) => void pending.delete(i),
    now: () => t,
    document: { hidden: false, addEventListener: () => {} },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    error: () => {},
  };
  const loop = createFrameLoop(env);
  const mkEngine = () => {
    const v = visViews(new SharedArrayBuffer(visBytes()));
    v.hdr[VIS_HDR.tapCh] = -1;
    const taps: number[] = [];
    return {
      v,
      taps,
      eng: { vis: () => v, sampleRate: 48000, setVisTap: (ch: number) => (taps.push(ch), true) },
    };
  };
  const bus = createAnalyserBus({ loop });
  return {
    loop,
    bus,
    mkEngine,
    /** One display frame `dt` ms after the last. */
    frame(dt = 1000 / 60) {
      t += dt;
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn(t);
    },
  };
}

/** Write `n` frames of a loud sine into a ring and publish its head (what the worklet does). */
function pump(v: VisViews, which: 'master' | 'tap', n: number) {
  const slot = which === 'master' ? VIS_HDR.masterHead : VIS_HDR.tapHead;
  const L = which === 'master' ? v.masterL : v.tapL;
  const R = which === 'master' ? v.masterR : v.tapR;
  const head = Atomics.load(v.hdr, slot);
  for (let i = 0; i < n; i++) {
    const h = head + i;
    const s = 0.9 * Math.sin((2 * Math.PI * 1000 * h) / 48000);
    L[h & (VIS_TAP_RING - 1)] = s;
    R[h & (VIS_TAP_RING - 1)] = s;
  }
  Atomics.store(v.hdr, slot, (head + n) | 0);
}

const view = (need: AnalyserNeed, onDraw: () => void = () => {}) => ({ need, draw: onDraw });

describe('analyserBus', () => {
  it('analyses at most 30 times a second', () => {
    const r = rig();
    const { eng } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    let draws = 0;
    r.bus.subscribe(view('mini', () => draws++));
    // A 120 Hz display for one second.
    for (let i = 0; i < 120; i++) r.frame(1000 / 120);
    expect(draws).toBeLessThanOrEqual(30);
    expect(draws).toBeGreaterThanOrEqual(28);
    // Re-registering (the want changes with every selection) never doubles the rate.
    const off = r.bus.subscribe(view('panel'));
    draws = 0;
    for (let i = 0; i < 60; i++) {
      r.bus.select(i % 2 === 0 ? 3 : 'master', 'trk');
      r.frame();
    }
    expect(draws).toBeLessThanOrEqual(30);
    off();
  });

  it('taps a strip only while the panel shows one', () => {
    const r = rig();
    const { v, eng, taps } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    r.bus.subscribe(view('mini'));
    r.bus.select(3, 'trk');
    // No panel on screen: no tap, master only.
    expect(taps).toEqual([]);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master);
    const off = r.bus.subscribe(view('panel'));
    expect(taps).toEqual([3]);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master | VIS_WANT.tap);
    r.bus.select('master');
    expect(taps).toEqual([3, -1]);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master);
    r.bus.toggle(5, 'other');
    expect(r.bus.selected).toBe(5);
    expect(taps).toEqual([3, -1, 5]);
    // Pressing the same strip's toggle again goes back to the Master.
    r.bus.toggle(5, 'other');
    expect(r.bus.selected).toBe('master');
    r.bus.toggle(5, 'other');
    off();
    expect(taps).toEqual([3, -1, 5, -1, 5, -1]);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master);
  });

  it('re-sends the tap after attach', () => {
    const r = rig();
    const a = r.mkEngine();
    r.loop.attach(a.eng);
    r.bus.attach(a.eng);
    r.bus.subscribe(view('panel'));
    r.bus.select(7, 'trk');
    expect(a.taps).toEqual([7]);
    // An audio restart: the old engine goes, a new one (tap off) comes.
    r.loop.attach(null);
    r.bus.attach(null);
    const b = r.mkEngine();
    r.loop.attach(b.eng);
    r.bus.attach(b.eng);
    expect(b.taps.at(-1)).toBe(7);
    expect(b.v.hdr[VIS_HDR.want]).toBe(VIS_WANT.tap);
  });

  it("falls back to Master when the strip's track is removed", () => {
    const r = rig();
    const { eng, taps } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    r.bus.subscribe(view('panel'));
    const seen: unknown[] = [];
    r.bus.onSelect((s) => seen.push(s));
    r.bus.select(3, 't3');
    r.bus.sync([{ ch: 3, key: 't3' }, { ch: 32, key: 'reverb' }]);
    expect(r.bus.selected).toBe(3);
    r.bus.sync([{ ch: 32, key: 'reverb' }]);
    expect(r.bus.selected).toBe('master');
    expect(taps.at(-1)).toBe(-1);
    // A new track that reuses the slot is not the one that was shown.
    r.bus.select(3, 't3');
    r.bus.sync([{ ch: 3, key: 't9' }]);
    expect(r.bus.selected).toBe('master');
    expect(seen).toEqual(['master', 3, 'master', 3, 'master']);
  });

  it('a tap-channel change resets the history', () => {
    const r = rig();
    const { v, eng } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    r.bus.subscribe(view('panel'));
    r.bus.select(3, 'trk');
    Atomics.store(v.hdr, VIS_HDR.tapCh, 3);
    for (let i = 0; i < 30; i++) {
      pump(v, 'tap', 800);
      r.frame();
    }
    expect(Math.max(...r.bus.panel.level)).toBeGreaterThan(-3);
    // The engine now taps another strip: its old frames are not this strip's.
    Atomics.store(v.hdr, VIS_HDR.tapCh, 4);
    pump(v, 'tap', 800);
    r.frame();
    r.frame();
    expect(Math.max(...r.bus.panel.level)).toBe(DB_FLOOR);
    expect(Math.max(...r.bus.panel.peak)).toBe(DB_FLOOR);
  });

  it('master views read the master ring and the stereo picture', () => {
    const r = rig();
    const { v, eng } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    r.bus.subscribe(view('mini'));
    r.bus.subscribe(view('stereo'));
    for (let i = 0; i < 60; i++) {
      pump(v, 'master', 800);
      r.frame();
    }
    // 1 kHz in the mini spectrum (20 bands), mono: correlation → +1.
    const i1k = r.bus.miniBands.bandOf(1000);
    expect(r.bus.mini.level[i1k]).toBeGreaterThan(-3);
    expect(r.bus.correlation).toBeGreaterThan(0.9);
    expect(r.bus.gonN).toBeGreaterThan(0);
  });

  it('a slow frame rate is not a pause; a ring that stood still restarts', () => {
    const r = rig();
    const { v, eng } = r.mkEngine();
    r.loop.attach(eng);
    r.bus.attach(eng);
    r.bus.subscribe(view('mini'));
    const i1k = r.bus.miniBands.bandOf(1000);
    r.frame();
    // A throttled tab: two frames a second, the ring moving all the while.
    for (let i = 0; i < 4; i++) {
      pump(v, 'master', 24000);
      r.frame(500);
      r.frame(); // a 30 Hz consumer runs on one of every two drawn frames
      expect(r.bus.mini.level[i1k]).toBeGreaterThan(-3);
    }
    // A pause: time passes, the ring stands still (its bit was off), then a
    // block arrives. The old sine must not show as current: silence, falling.
    pump(v, 'master', 128);
    r.frame(2000);
    r.frame();
    expect(r.bus.mini.level[i1k]).toBeLessThan(-3);
  });
});

