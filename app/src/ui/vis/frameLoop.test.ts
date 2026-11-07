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
