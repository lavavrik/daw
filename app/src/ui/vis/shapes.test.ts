import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADSR_LABEL_CHARS, PLATEAU, adsrCompactLabel, adsrLabel, voicesAria, adsrLayout, adsrPoints, adsrTimeToX, lfoLabel, lfoPoints, polyAt, voiceLedLevel,
} from './shapes';

// engine/tests/fixtures/shapes.json: the REAL Adsr / Lfo rendered by
// engine/tests/shapes.rs `shape_fixtures_are_current` (64 points per shape).
interface AdsrCase { name: string; attack: number; decay: number; sustain: number; release: number; delay: number; points: [number, number][] }
interface LfoCase { name: string; wave: number; rate: number; depth: number; sync: number; division: number; bpm: number; points: [number, number][] }
const fx = JSON.parse(readFileSync(new URL('../../../../engine/tests/fixtures/shapes.json', import.meta.url), 'utf8')) as {
  adsr: AdsrCase[];
  lfo: LfoCase[];
};

describe('shape previews', () => {
  it('adsr preview matches the engine', () => {
    expect(fx.adsr.length).toBe(3);
    expect(fx.adsr.some((c) => c.delay > 0)).toBe(true);
    for (const c of fx.adsr) {
      expect(c.points.length).toBe(64);
      const poly = adsrPoints(c);
      for (const [t, v] of c.points) {
        // The engine's point, mapped through the preview's time axis, on the drawn polyline.
        const x = adsrTimeToX(c, t);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
        expect(Math.abs(polyAt(poly, x) - v), `${c.name} @ ${t.toFixed(4)} s (x ${x.toFixed(3)})`).toBeLessThan(0.01);
      }
    }
  });

  it('lfo preview matches the engine', () => {
    expect(fx.lfo.length).toBe(8);
    expect(new Set(fx.lfo.map((c) => c.wave))).toEqual(new Set([0, 1, 2, 3]));
    expect(fx.lfo.some((c) => c.sync === 1) && fx.lfo.some((c) => c.sync === 0)).toBe(true);
    for (const c of fx.lfo) {
      expect(c.points.length).toBe(64);
      const poly = lfoPoints(c.wave, c.depth);
      for (const [phase, v] of c.points) {
        expect(Math.abs(polyAt(poly, phase) - v), `${c.name} @ phase ${phase.toFixed(4)}`).toBeLessThan(0.01);
      }
    }
  });

  it('segment widths follow √t', () => {
    const p = { delay: 0.25, attack: 0.001, decay: 1, sustain: 0.5, release: 4 };
    const l = adsrLayout(p);
    const w = (k: string) => l.find((s) => s.kind === k)!.x1 - l.find((s) => s.kind === k)!.x0;
    // Each timed segment's width ∝ √t; together they share the 80 % beside the plateau.
    const k = w('release') / Math.sqrt(4);
    for (const [kind, t] of [['delay', 0.25], ['attack', 0.001], ['decay', 1]] as const) expect(w(kind) / Math.sqrt(t)).toBeCloseTo(k, 9);
    expect(w('delay') + w('attack') + w('decay') + w('release')).toBeCloseTo(1 - PLATEAU, 9);
    // A 1 ms attack beside a 4 s release (default decay, no delay) is still visible (≥ 1 px of 120).
    const v = adsrLayout({ delay: 0, attack: 0.001, decay: 0.2, sustain: 0.7, release: 4 });
    expect((v[1].x1 - v[1].x0) * 120).toBeGreaterThan(1);
    // Contiguous, in order, 0 → 1; no delay = a zero-width delay segment.
    expect(l.map((s) => s.kind)).toEqual(['delay', 'attack', 'decay', 'sustain', 'release']);
    for (let i = 1; i < l.length; i++) expect(l[i].x0).toBe(l[i - 1].x1);
    expect(l[0].x0).toBe(0);
    expect(l.at(-1)!.x1).toBeCloseTo(1, 12);
    const nd = adsrLayout({ ...p, delay: 0 });
    expect(nd[0].x1 - nd[0].x0).toBe(0);
    // Mapping: segment ends land on segment edges, linear in time inside.
    expect(adsrTimeToX(p, 0.25)).toBeCloseTo(l[1].x0, 12);
    expect(adsrTimeToX(p, 0.25 + 0.001 + 0.5)).toBeCloseTo((l[2].x0 + l[2].x1) / 2, 12);
  });

  it('the plateau is 20 %', () => {
    for (const p of [
      { delay: 0, attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.3 },
      { delay: 4, attack: 10, decay: 10, sustain: 0, release: 10 },
      { delay: 0, attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 },
    ]) {
      const s = adsrLayout(p).find((x) => x.kind === 'sustain')!;
      expect(PLATEAU).toBe(0.2);
      expect(s.x1 - s.x0).toBeCloseTo(0.2, 12);
    }
  });

  it('voice LED level maps −48..0 dB to 0..1', () => {
    const db = (d: number) => 10 ** (d / 20);
    expect(voiceLedLevel(1)).toBeCloseTo(1, 9);
    expect(voiceLedLevel(db(-48))).toBeCloseTo(0, 9);
    expect(voiceLedLevel(db(-24))).toBeCloseTo(0.5, 9);
    expect(voiceLedLevel(db(-12))).toBeCloseTo(0.75, 9);
    expect(voiceLedLevel(db(-60))).toBe(0);
    expect(voiceLedLevel(0)).toBe(0);
    expect(voiceLedLevel(2)).toBe(1); // clamped above 0 dB
    expect(voiceLedLevel(NaN)).toBe(0);
  });

  it('labels give the real times', () => {
    expect(lfoLabel({ wave: 0, rate: 2, sync: 0, division: 3, depth: 1 }, 120)).toBe('2.00 Hz · 500 ms');
    expect(lfoLabel({ wave: 0, rate: 2, sync: 1, division: 3, depth: 1 }, 120)).toBe('1/4 · 500 ms');
    expect(lfoLabel({ wave: 0, rate: 2, sync: 1, division: 5, depth: 1 }, 120)).toBe('1 bar · 2.00 s');
    expect(lfoLabel({ wave: 0, rate: 0.25, sync: 0, division: 3, depth: 1 }, 120)).toBe('0.25 Hz · 4.00 s');
    expect(adsrLabel({ delay: 0, attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.3 })).toBe('5 ms · 200 ms · 70% · 300 ms');
    expect(adsrLabel({ delay: 0.25, attack: 1.2, decay: 0.2, sustain: 0.55, release: 2.5 })).toBe('+250 ms · 1.20 s · 200 ms · 55% · 2.50 s');
  });

  it('the ADSR label fits 120 px: compact, clamped, the full text kept', () => {
    expect(adsrCompactLabel({ delay: 0, attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.3 })).toBe('5ms·200ms·70%·300ms');
    expect(adsrCompactLabel({ delay: 0.25, attack: 0.8, decay: 1.5, sustain: 0.6, release: 2.5 })).toBe('+250ms·800ms·1.5s·60%·2.5s'.slice(0, 23) + '…');
    expect(adsrCompactLabel({ delay: 0.5, attack: 1.2, decay: 2, sustain: 0.55, release: 2.5 })).toBe('+500ms·1.2s·2.0s·55%·2.5s'.slice(0, 23) + '…');
    expect(adsrCompactLabel({ delay: 1, attack: 0.01, decay: 2, sustain: 0.55, release: 2.5 })).toBe('+1.0s·10ms·2.0s·55%·2.5s');
    expect(adsrCompactLabel({ delay: 0, attack: 10, decay: 10, sustain: 1, release: 10 })).toBe('10s·10s·100%·10s');
    // The longest: every time at "999ms" and a delay; clamped with an ellipsis.
    const longest = { delay: 0.999, attack: 0.999, decay: 0.999, sustain: 1, release: 0.999 };
    const c = adsrCompactLabel(longest);
    expect(c.length).toBeLessThanOrEqual(ADSR_LABEL_CHARS);
    expect(c.endsWith('…')).toBe(true);
    // 9 px tabular digits are ≤ 5 px wide: the budget fits 120 px.
    expect(ADSR_LABEL_CHARS * 5).toBeLessThanOrEqual(120);
    // The full text (title / screen readers) keeps everything.
    expect(adsrLabel(longest)).toBe('+999 ms · 999 ms · 999 ms · 100% · 999 ms');
  });

  it('the voice LEDs say how many voices play', () => {
    expect(voicesAria(0, 8)).toBe('0 of 8 voices playing');
    expect(voicesAria(3, 8)).toBe('3 of 8 voices playing');
    expect(voicesAria(1, 1)).toBe('1 of 1 voice playing');
  });
});
