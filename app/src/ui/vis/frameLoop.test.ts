import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop, type FrameEnv } from './frameLoop';
import { VIS_HDR, VIS_WANT, visBytes, visViews } from '../../audio/visLayout';

/** Fake rAF, clock, document and IntersectionObserver. */
function fakeEnv() {
  let t = 0;
  let nextId = 1;
  const pending = new Map<number, (now: number) => void>();
  const listeners: (() => void)[] = [];
  const observed = new Map<Element, (on: boolean) => void>();
  let ioCb: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
  };
  const errors: unknown[] = [];
  const env: FrameEnv = {
    raf: (fn) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    caf: (id) => void pending.delete(id),
    now: () => t,
    document: doc,
    IntersectionObserver: class {
      constructor(cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
        ioCb = cb;
      }
      observe(el: Element) {
        observed.set(el, () => {});
      }
      unobserve(el: Element) {
        observed.delete(el);
      }
      disconnect() {
        observed.clear();
      }
    },
    error: (...a: unknown[]) => void errors.push(a),
  };
  return {
    env,
    errors,
    /** Run one animation frame 1000/60 ms after the last. */
    frame(dt = 1000 / 60) {
      t += dt;
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn(t);
    },
    advance(ms: number) {
      t += ms;
    },
    pendingRafs: () => pending.size,
    setHidden(h: boolean) {
      doc.hidden = h;
      for (const fn of listeners) fn();
    },
    intersect(el: Element, on: boolean) {
      ioCb?.([{ target: el, isIntersecting: on }]);
    },
    isObserved: (el: Element) => observed.has(el),
  };
}

const engine = () => {
  const v = visViews(new SharedArrayBuffer(visBytes()));
  return { v, eng: { vis: () => v } };
};
const el = () => ({}) as Element;

describe('frameLoop', () => {
  it('runs only consumers on screen', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    const { v, eng } = engine();
    loop.attach(eng);
    const [a, b] = [el(), el()];
    const seen: string[] = [];
    loop.add({ want: VIS_WANT.master, el: a, frame: () => seen.push('a') });
    loop.add({ want: VIS_WANT.tap, el: b, frame: () => seen.push('b') });
    expect(f.isObserved(a) && f.isObserved(b)).toBe(true);
    // Nothing on screen yet: no frame, want 0.
    expect(f.pendingRafs()).toBe(0);
    expect(v.hdr[VIS_HDR.want]).toBe(0);
    f.intersect(a, true);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master);
    f.frame();
    f.frame();
    expect(seen).toEqual(['a', 'a']);
    f.intersect(b, true);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.master | VIS_WANT.tap);
    f.frame();
    expect(seen.slice(2)).toEqual(['a', 'b']);
    f.intersect(a, false);
    f.intersect(b, false);
    expect(v.hdr[VIS_HDR.want]).toBe(0);
    expect(f.pendingRafs()).toBe(0);
    // A consumer without an element always counts as on screen.
    const c: string[] = [];
    loop.add({ want: 0, frame: () => c.push('c') });
    f.frame();
    expect(c).toEqual(['c']);
    expect(seen).toHaveLength(4);
  });

  it('pauses when the document is hidden and clears the want mask', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    const { v, eng } = engine();
    loop.attach(eng);
    let n = 0;
    loop.add({ want: VIS_WANT.voices | VIS_WANT.master, frame: () => n++ });
    f.frame();
    expect(n).toBe(1);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.voices | VIS_WANT.master);
    f.setHidden(true);
    expect(v.hdr[VIS_HDR.want]).toBe(0);
    expect(f.pendingRafs()).toBe(0);
    f.frame();
    expect(n).toBe(1);
    f.setHidden(false);
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.voices | VIS_WANT.master);
    f.frame();
    expect(n).toBe(2);
  });

  it('stops the rAF with no consumers', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    const { v, eng } = engine();
    loop.attach(eng);
    const remove = loop.add({ want: VIS_WANT.tap, frame: () => {} });
    expect(f.pendingRafs()).toBe(1);
    f.frame();
    expect(f.pendingRafs()).toBe(1);
    remove();
    expect(f.pendingRafs()).toBe(0);
    expect(v.hdr[VIS_HDR.want]).toBe(0);
    // Detaching the engine also stops it (and clears its want mask).
    loop.add({ want: VIS_WANT.tap, frame: () => {} });
    expect(v.hdr[VIS_HDR.want]).toBe(VIS_WANT.tap);
    loop.attach(null);
    expect(f.pendingRafs()).toBe(0);
    expect(v.hdr[VIS_HDR.want]).toBe(0);
  });

  it('30 Hz consumers run every other frame', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    loop.attach(engine().eng);
    let fast = 0;
    let slow = 0;
    loop.add({ want: 0, frame: () => fast++ });
    loop.add({ want: 0, hz: 30, frame: () => slow++ });
    for (let i = 0; i < 10; i++) f.frame();
    expect(fast).toBe(10);
    expect(slow).toBe(5);
    // A 120 Hz display still draws at most 60 frames a second.
    for (let i = 0; i < 20; i++) f.frame(1000 / 120);
    expect(fast).toBe(20);
  });

  it('accounts busy time', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    loop.attach(engine().eng);
    loop.add({ want: 0, frame: () => f.advance(2) });
    loop.add({ want: 0, hz: 30, frame: () => f.advance(1) });
    for (let i = 0; i < 6; i++) f.frame();
    let s = loop.stats();
    expect(s.frames).toBe(6);
    expect(s.busyMs).toBeCloseTo(6 * 2 + 3 * 1, 6);
    expect(s.wallMs).toBeGreaterThan(6 * (1000 / 60));
    // Rolling 5 s: old frames drop out.
    for (let i = 0; i < 400; i++) f.frame();
    s = loop.stats();
    expect(s.wallMs).toBeLessThanOrEqual(5000);
    expect(s.frames).toBeLessThanOrEqual(301);
    expect(s.busyMs / s.wallMs).toBeGreaterThan(0.1);
  });

  it('draws at most 60 frames a second at any refresh rate', () => {
    for (const hz of [60, 75, 120, 144, 240]) {
      const f = fakeEnv();
      const loop = createFrameLoop(f.env);
      loop.attach(engine().eng);
      let n = 0;
      loop.add({ want: 0, frame: () => n++ });
      for (let i = 0; i < hz; i++) f.frame(1000 / hz); // one second
      expect(n, `${hz} Hz`).toBeLessThanOrEqual(60);
      // Every 1st, 2nd, 3rd or 4th display frame: 60, 37, 60, 48, 60.
      expect(n, `${hz} Hz`).toBeGreaterThanOrEqual({ 60: 60, 75: 37, 120: 60, 144: 48, 240: 60 }[hz]!);
    }
  });

  it('stats count only the time the loop ran', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    loop.attach(engine().eng);
    loop.add({ want: 0, frame: () => f.advance(1) });
    for (let i = 0; i < 60; i++) f.frame(); // ~1 s running
    f.setHidden(true);
    f.advance(3000); // paused: not wall time
    f.setHidden(false);
    for (let i = 0; i < 30; i++) f.frame(); // ~0.5 s running
    const s = loop.stats();
    expect(s.frames).toBe(90);
    expect(s.busyMs).toBeCloseTo(90, 6);
    // ~1.5 s of running (plus the 1 ms callbacks), not the 4.5 s since start.
    expect(s.wallMs).toBeGreaterThan(1500);
    expect(s.wallMs).toBeLessThan(1700);
    // Long after a pause, only the running time inside the last 5 s counts.
    f.setHidden(true);
    f.advance(10_000);
    expect(loop.stats()).toEqual({ busyMs: 0, wallMs: 0, frames: 0 });
    f.setHidden(false);
    for (let i = 0; i < 60; i++) f.frame();
    const t = loop.stats();
    expect(t.frames).toBe(60);
    expect(t.wallMs).toBeGreaterThan(1000);
    expect(t.wallMs).toBeLessThan(1100);
  });

  it('remembers the strip tap and re-sends it to a new engine', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    const sent: [string, number][] = [];
    const eng = (name: string) => ({ vis: engine().eng.vis, setVisTap: (ch: number) => (sent.push([name, ch]), true) });
    const a = eng('a');
    loop.attach(a);
    expect(sent).toEqual([]); // nothing chosen yet: a new engine starts off
    loop.setTap(3);
    expect(sent).toEqual([['a', 3]]);
    // An audio restart: the new engine gets the same tap.
    loop.attach(null);
    loop.attach(eng('b'));
    expect(sent).toEqual([['a', 3], ['b', 3]]);
    loop.setTap(-1);
    loop.attach(eng('c'));
    expect(sent).toEqual([['a', 3], ['b', 3], ['b', -1]]);
    // Chosen while detached: sent on attach.
    loop.attach(null);
    loop.setTap(33);
    loop.attach(eng('d'));
    expect(sent.at(-1)).toEqual(['d', 33]);
  });

  it('a throwing consumer is dropped, the rest keep running', () => {
    const f = fakeEnv();
    const loop = createFrameLoop(f.env);
    loop.attach(engine().eng);
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    let good = 0;
    loop.add({ want: 0, frame: bad });
    loop.add({ want: 0, frame: () => good++ });
    f.frame();
    f.frame();
    f.frame();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toBe(3);
    expect(f.errors).toHaveLength(1);
  });
});
