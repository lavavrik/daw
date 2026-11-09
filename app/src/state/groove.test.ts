// Swing presets and Humanize (plan 25 Task 3): the pure maths (groove.ts)
// and the two actions (humanizeDrum in actions.ts, humanizeNotes in
// pattern-actions.ts), with a real undo history.
import { describe, expect, it } from 'vitest';
import { BAR_TICKS, Op } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import { addDrumTrack, humanizeDrum, setStep, setSwing } from './actions';
import { addNote, humanizeNotes, patternTicks, setPatternBars } from './pattern-actions';
import { addSynthTrack } from './rack-actions';
import { createHistory, debugStacks } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import {
  HUMANIZE_TICKS, HUMANIZE_VEL, SWING_PRESETS, activeSwingPreset, humanizeSeed, humanizedStart, humanizedVel, jitter,
  mpcToSwing, peekHumanizeCounter, swingToMpc,
} from './groove';

function rig() {
  const p = new Project();
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  const entries = () => debugStacks(p.history!).undo.length;
  return { p, sink, sent, entries };
}

describe('swing presets (MPC % <-> engine swing)', () => {
  it('maps MPC 50 % to straight and each preset onto the off-16th position the engine plays', () => {
    expect(SWING_PRESETS.map((s) => [s.label, s.mpc, s.swing])).toEqual([
      ['Straight', 50, 0], ['54 %', 54, 0.16], ['58 %', 58, 0.32], ['62 %', 62, 0.48], ['66 %', 66, 0.64],
    ]);
    for (const s of SWING_PRESETS) {
      // engine/src/drums.rs step_tick: odd 16ths late by swing * 0.5 * 240 ticks, in a 480-tick pair.
      const offTick = 240 + s.swing * 0.5 * 240;
      expect(offTick / 480).toBeCloseTo(s.mpc / 100, 10);
      expect(swingToMpc(s.swing)).toBeCloseTo(s.mpc, 10);
      // On the slider's 1 % grid.
      expect(Math.round(s.swing * 100) / 100).toBe(s.swing);
    }
    expect(mpcToSwing(50 + 50 / 3)).toBeCloseTo(2 / 3, 10); // a true 16th triplet (66.7 %)
    expect(mpcToSwing(75)).toBe(1); // the slider's top
  });

  it('activeSwingPreset matches at the slider resolution only', () => {
    expect(activeSwingPreset(0)?.label).toBe('Straight');
    expect(activeSwingPreset(0.32)?.label).toBe('58 %');
    expect(activeSwingPreset(0.32 + 1e-9)?.label).toBe('58 %');
    expect(activeSwingPreset(0.33)).toBeNull();
    expect(activeSwingPreset(1)).toBeNull();
  });

  it('a preset is one setSwing: one undo entry, SET_SWING with the preset value', () => {
    const { p, sink, sent, entries } = rig();
    const t = addDrumTrack(p, sink)!;
    const n = entries();
    sent.length = 0;
    setSwing(p, sink, t.id, SWING_PRESETS[2].swing);
    expect(entries()).toBe(n + 1);
    expect(p.history!.labels.undo).toBe('Swing');
    expect(sent).toEqual([[Op.SET_SWING, t.slot, 0.32, 0, 0]]);
  });
});

describe('jitter', () => {
  it('is deterministic per seed and key, in [-1, 1), and differs across seeds', () => {
    const seed = humanizeSeed('pat-a', 0);
    expect(humanizeSeed('pat-a', 0)).toBe(seed);
    expect(humanizeSeed('pat-a', 1)).not.toBe(seed);
    expect(humanizeSeed('pat-b', 0)).not.toBe(seed);
    const xs = Array.from({ length: 2000 }, (_, i) => jitter(seed, `k${i}`));
    expect(xs).toEqual(Array.from({ length: 2000 }, (_, i) => jitter(seed, `k${i}`)));
    expect(xs.every((x) => x >= -1 && x < 1)).toBe(true);
    // Roughly uniform: both signs, and a mean near 0.
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(xs.filter((x) => x > 0.5).length).toBeGreaterThan(350);
    expect(xs.filter((x) => x < -0.5).length).toBeGreaterThan(350);
    const other = Array.from({ length: 2000 }, (_, i) => jitter(humanizeSeed('pat-a', 1), `k${i}`));
    expect(other).not.toEqual(xs);
  });

  it('humanizedVel stays at 1..127 and within ±HUMANIZE_VEL x amount', () => {
    for (let i = 0; i < 500; i++) {
      const seed = humanizeSeed('v', i);
      for (const v of [1, 2, 64, 126, 127]) {
        const out = humanizedVel(v, seed, 'x', 1);
        expect(out).toBeGreaterThanOrEqual(1);
        expect(out).toBeLessThanOrEqual(127);
        expect(Math.abs(out - v)).toBeLessThanOrEqual(HUMANIZE_VEL);
        expect(Math.abs(humanizedVel(v, seed, 'x', 0.25) - v)).toBeLessThanOrEqual(Math.ceil(HUMANIZE_VEL * 0.25));
      }
    }
  });

  it('humanizedStart keeps a note inside the pattern', () => {
    const total = BAR_TICKS;
    for (let i = 0; i < 500; i++) {
      const seed = humanizeSeed('t', i);
      for (const [start, len] of [[0, 240], [3, 240], [total - 240, 240], [total - 245, 240], [100, total - 100]]) {
        const s = humanizedStart(start, len, total, seed, 'n', 1);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s + len).toBeLessThanOrEqual(total);
        expect(Math.abs(s - start)).toBeLessThanOrEqual(HUMANIZE_TICKS);
      }
      // Already overhanging (or longer than the pattern): only earlier, never later.
      expect(humanizedStart(total - 100, 240, total, seed, 'n', 1)).toBeLessThanOrEqual(total - 100);
      expect(humanizedStart(0, total * 2, total, seed, 'n', 1)).toBe(0);
    }
  });
});

describe('humanizeDrum', () => {
  /** A drum track with every 16th of rows 0 and 1 lit (100 and 127), and a step past the step count. */
  function drums() {
    const r = rig();
    const t = addDrumTrack(r.p, r.sink)!;
    for (let s = 0; s < 16; s++) {
      setStep(r.p, r.sink, t.id, t.rows[0].id, s, 100);
      setStep(r.p, r.sink, t.id, t.rows[1].id, s, s % 2 ? 127 : 1);
    }
    setStep(r.p, r.sink, t.id, t.rows[2].id, 20, 90); // hidden at 16 steps
    r.sent.length = 0;
    const steps = () => currentPattern(t).steps.map((row) => [...row]);
    return { ...r, t, steps };
  }

  it('jitters lit steps only, at 1..127, never turning one off or on; one undo entry', () => {
    const { p, sink, sent, t, steps, entries } = drums();
    const before = steps();
    const n = entries();
    const changed = humanizeDrum(p, sink, t.id, 1);
    const after = steps();
    expect(changed).toBeGreaterThan(10);
    expect(entries()).toBe(n + 1);
    expect(p.history!.labels.undo).toBe('Humanize');
    for (let r = 0; r < before.length; r++) {
      for (let s = 0; s < before[r].length; s++) {
        if (before[r][s] === 0 || s >= 16) {
          expect(after[r][s]).toBe(before[r][s]); // off stays off; past the step count untouched
          continue;
        }
        expect(after[r][s]).toBeGreaterThanOrEqual(1);
        expect(after[r][s]).toBeLessThanOrEqual(127);
        expect(Math.abs(after[r][s] - before[r][s])).toBeLessThanOrEqual(HUMANIZE_VEL);
      }
    }
    expect(sent.every((c) => c[0] === Op.SET_STEP)).toBe(true);
    expect(sent).toHaveLength(changed);
    // Undo puts every velocity back in that one step.
    p.history!.undo();
    expect(steps()).toEqual(before);
    p.history!.redo();
    expect(steps()).toEqual(after);
  });

  it('is deterministic: the pattern id and counter 0, then counter 1 for the next', () => {
    const { p, sink, t, steps } = drums();
    const pat = currentPattern(t);
    const before = steps();
    const expected = (counter: number, from: number[][]) => from.map((row, r) => row.map((v, s) => (
      v === 0 || s >= 16 || r >= t.rows.length ? v : humanizedVel(v, humanizeSeed(pat.id, counter), `${r}:${s}`, 0.5)
    )));
    humanizeDrum(p, sink, t.id, 0.5);
    expect(steps()).toEqual(expected(0, before));
    const mid = steps();
    humanizeDrum(p, sink, t.id, 0.5);
    expect(steps()).toEqual(expected(1, mid));
    expect(steps()).not.toEqual(expected(0, mid));
  });

  it('amount 0 (or NaN) is a no-op with no undo entry; amounts past 1 clamp', () => {
    const { p, sink, sent, t, steps, entries } = drums();
    const before = steps();
    const n = entries();
    expect(humanizeDrum(p, sink, t.id, 0)).toBe(0);
    expect(humanizeDrum(p, sink, t.id, NaN)).toBe(0);
    expect(humanizeDrum(p, sink, t.id, -1)).toBe(0);
    expect(steps()).toEqual(before);
    expect(sent).toEqual([]);
    expect(entries()).toBe(n);
    humanizeDrum(p, sink, t.id, 5);
    for (const [r, s] of [[0, 3], [1, 4]]) expect(Math.abs(steps()[r][s] - before[r][s])).toBeLessThanOrEqual(HUMANIZE_VEL);
  });

  it('an empty pattern makes no entry; a synth track id is refused', () => {
    const { p, sink, entries } = rig();
    const t = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    const n = entries();
    expect(humanizeDrum(p, sink, t.id, 1)).toBe(0);
    expect(humanizeDrum(p, sink, s.id, 1)).toBe(0);
    expect(entries()).toBe(n);
  });

  it('a Humanize that changes nothing uses no counter: the next one is still counter 0', () => {
    const { p, sink, entries } = rig();
    const t = addDrumTrack(p, sink)!;
    const n = entries();
    expect(humanizeDrum(p, sink, t.id, 1)).toBe(0); // empty: nothing to change
    expect(peekHumanizeCounter(currentPattern(t).id)).toBe(0);
    expect(entries()).toBe(n);
    setStep(p, sink, t.id, t.rows[0].id, 0, 100);
    expect(humanizeDrum(p, sink, t.id, 1)).toBeGreaterThan(0);
    expect(peekHumanizeCounter(currentPattern(t).id)).toBe(1);
  });
});

describe('humanizeNotes', () => {
  /**
   * A two-bar synth pattern: notes at the start, mid-bar, flush with the
   * end, one overhanging the end, and one past the end (kept, silent).
   */
  function synth() {
    const r = rig();
    const t = addSynthTrack(r.p, r.sink)!;
    setPatternBars(r.p, r.sink, t.id, 3);
    const at = [0, 240, 480, 1200, 2 * BAR_TICKS - 240, 2 * BAR_TICKS - 100];
    for (const start of at) addNote(r.p, r.sink, t.id, { pitch: 60, start, len: 240, vel: 100 });
    addNote(r.p, r.sink, t.id, { pitch: 62, start: 2 * BAR_TICKS + 100, len: 240 }); // past the end once bars = 2
    setPatternBars(r.p, r.sink, t.id, 2);
    r.sent.length = 0;
    const notes = () => currentPattern(t).notes.map((n) => ({ ...n }));
    return { ...r, t, notes };
  }

  it('moves starts and velocities within range, inside the pattern; one undo entry', () => {
    const { p, sink, sent, t, notes, entries } = synth();
    const before = notes();
    const n = entries();
    humanizeNotes(p, sink, t.id, 1);
    const after = notes();
    expect(entries()).toBe(n + 1);
    expect(p.history!.labels.undo).toBe('Humanize');
    const total = patternTicks(t);
    expect(after.filter((x, i) => x.start !== before[i].start).length).toBeGreaterThan(0);
    expect(after.filter((x, i) => x.vel !== before[i].vel).length).toBeGreaterThan(0);
    after.forEach((x, i) => {
      const b = before[i];
      expect([x.id, x.pitch, x.len]).toEqual([b.id, b.pitch, b.len]);
      if (b.start >= total) return expect(x).toEqual(b); // past the end: untouched
      expect(x.start).toBeGreaterThanOrEqual(0);
      if (b.start + b.len > total) expect(x.start).toBeLessThanOrEqual(b.start); // overhanging: its end never grows
      else expect(x.start + x.len).toBeLessThanOrEqual(total);
      expect(Math.abs(x.start - b.start)).toBeLessThanOrEqual(HUMANIZE_TICKS);
      expect(Math.abs(x.vel - b.vel)).toBeLessThanOrEqual(HUMANIZE_VEL);
    });
    expect(sent.every((c) => c[0] === Op.NOTE_SET)).toBe(true);
    p.history!.undo();
    expect(notes()).toEqual(before);
    p.history!.redo();
    expect(notes()).toEqual(after);
  });

  it('is deterministic: the pattern id and counter, each note keyed by its id', () => {
    const { p, sink, t, notes } = synth();
    const pat = currentPattern(t);
    const before = notes();
    humanizeNotes(p, sink, t.id, 0.7);
    const seed = humanizeSeed(pat.id, 0);
    const total = patternTicks(t);
    expect(notes()).toEqual(before.map((b) => (b.start >= total ? b : {
      ...b, start: humanizedStart(b.start, b.len, total, seed, b.id, 0.7), vel: humanizedVel(b.vel, seed, b.id, 0.7),
    })));
  });

  it('only the given ids, when there are some', () => {
    const { p, sink, t, notes } = synth();
    const before = notes();
    humanizeNotes(p, sink, t.id, 1, [before[1].id]);
    const after = notes();
    after.forEach((x, i) => { if (i !== 1) expect(x).toEqual(before[i]); });
  });

  it('returns how many notes changed, like humanizeDrum; nothing changed: no entry, no counter used', () => {
    const { p, sink, t, notes, entries } = synth();
    const before = notes();
    const changed = humanizeNotes(p, sink, t.id, 1);
    const after = notes();
    expect(changed).toBe(after.filter((x, i) => x.start !== before[i].start || x.vel !== before[i].vel).length);
    expect(changed).toBeGreaterThan(0);
    const pat = currentPattern(t);
    const counter = peekHumanizeCounter(pat.id);
    const n = entries();
    expect(humanizeNotes(p, sink, t.id, 1, ['no-such-note'])).toBe(0);
    expect(entries()).toBe(n);
    expect(peekHumanizeCounter(pat.id)).toBe(counter);
  });

  it('amount 0 is a no-op with no undo entry', () => {
    const { p, sink, sent, t, notes, entries } = synth();
    const before = notes();
    const n = entries();
    expect(humanizeNotes(p, sink, t.id, 0)).toBe(0);
    expect(notes()).toEqual(before);
    expect(sent).toEqual([]);
    expect(entries()).toBe(n);
  });
});
