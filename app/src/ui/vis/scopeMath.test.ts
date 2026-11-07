import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIVISION_TICKS, findScope, readout, scopeWindow, windowFrames, windowLen } from './scopeMath';
import { SCOPE_FLAG, SCOPE_HDR, VIS_GUARD } from '../../audio/visLayout';
import { VIS_SCOPE_HDR, VIS_SCOPE_RING, VIS_SCOPES } from '../../audio/protocol';

const M = VIS_SCOPE_RING - 1;
const SR = 48000;

/** One slot: its ring (entries of A min, A max, B min, B max) and header. */
function slot(head: number, epoch: number) {
  const ring = new Float32Array(VIS_SCOPE_RING * 4);
  const hdr = new Int32Array(VIS_SCOPE_HDR);
  hdr[SCOPE_HDR.head] = head | 0;
  hdr[SCOPE_HDR.epoch] = epoch | 0;
  hdr[SCOPE_HDR.decim] = 1;
  return { ring, hdr };
}

/** Write entries `from..to` (head values, wrapping) from `f(entry index)`
 * = [min, max] of A. */
function fill(ring: Float32Array, from: number, to: number, f: (j: number) => [number, number]) {
  for (let j = from | 0; j !== (to | 0); j = (j + 1) | 0) {
    const [lo, hi] = f(j);
    const at = (j & M) * 4;
    ring[at] = lo;
    ring[at + 1] = hi;
  }
}

/** A 110 Hz saw (−1..1) sampled at 48 kHz, `decim` frames per entry; entry
 * `j` counted from `base` (so a wrapped head still reads one waveform). */
function saw(decim: number, base: number) {
  const s = (n: number) => 2 * ((n * 110 / SR) % 1) - 1;
  return (j: number): [number, number] => {
    const k = ((j - base) | 0) >>> 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < decim; i++) {
      const x = Math.fround(s(k * decim + i));
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return [lo, hi];
  };
}

const mid = (ring: Float32Array, j: number) => (ring[(j & M) * 4] + ring[(j & M) * 4 + 1]) / 2;
/** Is there a rising zero crossing of A's mid at `j` ± 1 entry? */
function onCrossing(ring: Float32Array, j: number): boolean {
  for (const c of [j - 1, j, j + 1]) if (mid(ring, (c - 1) | 0) < 0 && mid(ring, c | 0) >= 0) return true;
  return false;
}

/** A ring proxy that records which ring entries (head positions) are read. */
function spyRing(ring: Float32Array) {
  const read = new Set<number>();
  const p = new Proxy(ring, {
    get(t, k) {
      if (typeof k === 'string' && /^\d+$/.test(k)) read.add(Number(k) >> 2);
      const x = Reflect.get(t, k, t);
      return typeof x === 'function' ? x.bind(t) : x;
    },
  });
  return { p, read };
}

describe('scopeMath', () => {
  it('triggers on a rising zero crossing', () => {
    // A 110 Hz saw (a period is ~436 entries at decim 1, ~145 at decim 3):
    // over 30 successive heads, every window starts on a crossing.
    for (const decim of [1, 3]) {
      const { ring, hdr } = slot(0, 0);
      hdr[SCOPE_HDR.decim] = decim;
      const f = saw(decim, 0);
      let head = 0;
      const len = Math.round(480 / decim); // 10 ms
      for (let k = 0; k < 30; k++) {
        // A long first stretch (a window plus a period), then a frame's worth.
        const next = (k === 0 ? 1200 : head + 37 + 13 * (k % 5));
        fill(ring, head, next, f);
        head = next;
        hdr[SCOPE_HDR.head] = head;
        const w = scopeWindow(ring, hdr, { sync: false, trig: 0 }, len);
        expect(w.triggered, `decim ${decim} head ${head}`).toBe(true);
        expect(w.len).toBe(len);
        expect((head - w.start) | 0).toBeGreaterThanOrEqual(len);
        expect(onCrossing(ring, w.start), `decim ${decim} head ${head} start ${w.start}`).toBe(true);
        // The latest one: no crossing between it and head - len.
        for (let j = w.start + 2; j <= head - len; j++) expect(mid(ring, j - 1) < 0 && mid(ring, j) >= 0, `later crossing at ${j}`).toBe(false);
      }
    }
  });

  it('free-runs when nothing crosses', () => {
    const { ring, hdr } = slot(1500, 0);
    fill(ring, 0, 1500, () => [0.5, 0.5]); // DC
    expect(scopeWindow(ring, hdr, { sync: false, trig: 0 }, 400)).toEqual({ start: 1100, len: 400, triggered: false });
    // Trigger Free: always the latest entries, crossing or not.
    const s = slot(3000, 0);
    fill(s.ring, 0, 3000, saw(1, 0));
    expect(scopeWindow(s.ring, s.hdr, { sync: false, trig: 1 }, 400)).toEqual({ start: 2600, len: 400, triggered: false });
    // Fewer entries than the window since the epoch: what there is.
    const e = slot(1100, 1000);
    expect(scopeWindow(e.ring, e.hdr, { sync: false, trig: 1 }, 400)).toEqual({ start: 1000, len: 100, triggered: false });
  });

  it('never reads before the epoch or inside the guard', () => {
    const cases = [
      { head: 5000, epoch: 4700 }, // a recent epoch: only 300 entries
      { head: 5000, epoch: 0 }, // a long history: the guard bounds it
      { head: 5000, epoch: 5100 }, // the header is newer than the head read
    ];
    for (const { head, epoch } of cases) {
      for (const o of [{ sync: false, trig: 0 }, { sync: false, trig: 1 }, { sync: true, trig: 0 }]) {
        const { ring, hdr } = slot(head, epoch);
        fill(ring, 0, head, saw(1, 0));
        hdr[SCOPE_HDR.flags] = SCOPE_FLAG.sync | SCOPE_FLAG.grid;
        hdr[SCOPE_HDR.gridPrev] = head - 1900; // inside the guard: must not be used
        hdr[SCOPE_HDR.gridLast] = head - 900;
        const { p, read } = spyRing(ring);
        const w = scopeWindow(p, hdr, o, 1024);
        const lo = Math.max(Math.min(epoch, head), head - (VIS_SCOPE_RING - VIS_GUARD));
        const allowed = new Set<number>();
        for (let j = lo; j < head; j++) allowed.add(j & M);
        for (const r of read) expect(allowed.has(r), `read entry pos ${r} (epoch ${epoch}, ${JSON.stringify(o)})`).toBe(true);
        // The window itself stays inside, too.
        expect(w.start).toBeGreaterThanOrEqual(lo);
        expect(w.start + w.len).toBeLessThanOrEqual(head);
      }
    }
  });

  it('heads wrap at 2^31', () => {
    const base = (2 ** 31 - 700) | 0;
    const head = (base + 1400) | 0;
    expect(head).toBeLessThan(0);
    const { ring, hdr } = slot(head, base);
    fill(ring, base, head, saw(1, base));
    const w = scopeWindow(ring, hdr, { sync: false, trig: 0 }, 480);
    expect(w.triggered).toBe(true);
    expect((head - w.start) | 0).toBeGreaterThanOrEqual(480);
    expect((w.start - base) | 0).toBeGreaterThanOrEqual(0);
    expect(onCrossing(ring, w.start)).toBe(true);
    expect(scopeWindow(ring, hdr, { sync: false, trig: 1 }, 480).start).toBe((head - 480) | 0);
  });

  it('sync shows the last whole division', () => {
    const { ring, hdr } = slot(4000, 0);
    fill(ring, 0, 4000, saw(24, 0));
    hdr[SCOPE_HDR.flags] = SCOPE_FLAG.sync | SCOPE_FLAG.grid;
    hdr[SCOPE_HDR.gridPrev] = 2950;
    hdr[SCOPE_HDR.gridLast] = 3950;
    expect(scopeWindow(ring, hdr, { sync: true, trig: 0 }, 1000)).toEqual({ start: 2950, len: 1000, triggered: true });
    // Trigger Free does not override the grid: Sync is the timebase.
    expect(scopeWindow(ring, hdr, { sync: true, trig: 1 }, 1000).start).toBe(2950);
    // Grid not valid (stopped, or just after a seek): Auto.
    hdr[SCOPE_HDR.flags] = SCOPE_FLAG.sync;
    const auto = scopeWindow(ring, hdr, { sync: true, trig: 0 }, 1000);
    expect(auto.start).not.toBe(2950);
    expect(auto).toEqual(scopeWindow(ring, hdr, { sync: false, trig: 0 }, 1000));
  });

  it('findScope matches track and module', () => {
    const hdrs = new Int32Array(VIS_SCOPES * VIS_SCOPE_HDR);
    for (let s = 0; s < VIS_SCOPES; s++) {
      hdrs[s * VIS_SCOPE_HDR + SCOPE_HDR.ownerTrack] = -1;
      hdrs[s * VIS_SCOPE_HDR + SCOPE_HDR.ownerModule] = -1;
    }
    const own = (s: number, t: number, m: number) => {
      hdrs[s * VIS_SCOPE_HDR + SCOPE_HDR.ownerTrack] = t;
      hdrs[s * VIS_SCOPE_HDR + SCOPE_HDR.ownerModule] = m;
    };
    own(2, 1, 5);
    own(5, 1, 6);
    own(7, 2, 5);
    expect(findScope(hdrs, 1, 5)).toBe(2);
    expect(findScope(hdrs, 1, 6)).toBe(5);
    expect(findScope(hdrs, 2, 5)).toBe(7);
    expect(findScope(hdrs, 3, 5)).toBe(-1);
    expect(findScope(hdrs, -1, -1)).toBe(-1);
  });

  it('header fields match the engine (scope.rs HDR_* / FLAG_*)', () => {
    const src = readFileSync(new URL('../../../../engine/src/rack/modules/scope.rs', import.meta.url), 'utf8');
    const camel = (s: string) => s.toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    const hdr = Object.fromEntries([...src.matchAll(/pub const HDR_(\w+): usize = (\d+);/g)].map((m) => [camel(m[1]), Number(m[2])]));
    expect(hdr).toEqual(SCOPE_HDR);
    const flags = Object.fromEntries([...src.matchAll(/pub const FLAG_(\w+): i32 = (\d+);/g)].map((m) => [camel(m[1]), Number(m[2])]));
    expect(flags).toEqual(SCOPE_FLAG);
  });

  it('window lengths and the readout follow the engine timebase', () => {
    const cat = readFileSync(new URL('../../../../engine/src/rack/catalog.rs', import.meta.url), 'utf8');
    const m = cat.match(/LFO_DIVISION_TICKS: \[f64; 8\] = \[([^\]]+)\]/)!;
    expect(m[1].split(',').map((x) => Number(x.trim()))).toEqual([...DIVISION_TICKS]);
    // As scope_decimation_follows_time: 5 ms -> 2400 frames at decim 3 = 800 entries.
    expect(windowFrames({ time: 5, sync: false, division: 3 }, SR, 120)).toBe(2400);
    expect(windowLen(2400, 3)).toBe(800);
    expect(windowFrames({ time: 5, sync: true, division: 5 }, SR, 120)).toBe(96000);
    expect(windowLen(96000, 94)).toBe(1021);
    expect(windowLen(48000, 1)).toBe(1024);
    expect(readout(5, false, '1/4')).toBe('5 ms/div');
    expect(readout(0.25, false, '1/4')).toBe('0.25 ms/div');
    expect(readout(12.4, false, '1/4')).toBe('12 ms/div');
    expect(readout(2.5, false, '1/4')).toBe('2.5 ms/div');
    expect(readout(5, true, '1/4')).toBe('1/4 · sync');
  });
});
