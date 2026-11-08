import { describe, expect, it } from 'vitest';
import type { Note } from './project.svelte';
import {
  convertSteps, DEFAULT_BASE, normalizeSteps, planEdit, readSteps, REST, stepPitch,
  type AcidStep, type NoteDiff, type NoteInit,
} from './acidSteps';

// --- helpers -----------------------------------------------------------------

const note = (key: number, extra: Partial<AcidStep> = {}): AcidStep =>
  ({ kind: 'note', key, oct: 0, accent: false, slide: false, ...extra });
const tie = (slide = false): AcidStep => ({ kind: 'tie', key: 0, oct: 0, accent: false, slide });

/** `head` padded with rests to bars·16 steps. */
function pad(head: AcidStep[], bars = 1): AcidStep[] {
  return [...head, ...Array.from({ length: bars * 16 - head.length }, () => REST)];
}

let nextId = 0;
function mk(start: number, len: number, pitch = 36, vel = 80, id?: string): Note {
  return { id: id ?? `n${nextId++}`, idx: 0, pitch, vel, start, len };
}

/** Apply a diff the way Task 3 will (addNote / updateNotes / deleteNotes). */
function apply(notes: readonly Note[], d: NoteDiff): Note[] {
  const gone = new Set(d.remove);
  const out = notes.filter((n) => !gone.has(n.id)).map((n) => ({ ...n }));
  for (const u of d.update) {
    const n = out.find((m) => m.id === u.id)!;
    const { id: _id, ...fields } = u;
    Object.assign(n, fields);
  }
  for (const a of d.add) out.push(mk(a.start, a.len, a.pitch, a.vel));
  return out;
}

/** Write `steps` into an empty pattern. */
function write(steps: AcidStep[], bars = 1, base = DEFAULT_BASE): NoteInit[] {
  const d = planEdit([], bars, base, steps);
  expect(d.update).toEqual([]);
  expect(d.remove).toEqual([]);
  return d.add;
}

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSteps(rnd: () => number, n: number): AcidStep[] {
  const kinds = ['note', 'rest', 'tie'] as const;
  return Array.from({ length: n }, () => ({
    kind: kinds[Math.floor(rnd() * 3)],
    key: Math.floor(rnd() * 12),
    oct: (Math.floor(rnd() * 3) - 1) as -1 | 0 | 1,
    accent: rnd() < 0.3,
    slide: rnd() < 0.3,
  }));
}

// --- writing -----------------------------------------------------------------

describe('acid steps: writing', () => {
  it('round_trip_canonical', () => {
    const rnd = mulberry32(17);
    for (let t = 0; t < 200; t++) {
      const bars = 1 + (t % 4);
      const base = [24, 36, 48, 60][t % 4];
      const raw = randomSteps(rnd, bars * 16);
      const notes = write(raw, bars, base).map((a) => mk(a.start, a.len, a.pitch, a.vel));
      const view = readSteps(notes, bars, base);
      expect(view).toEqual({ ok: true, base, steps: normalizeSteps(raw, bars) });
      // The canonical write is a fixed point: re-planning the same steps is a no-op.
      expect(planEdit(notes, bars, base, raw)).toEqual({ add: [], update: [], remove: [] });
    }
  });

  it('plain_note_is_120', () => {
    expect(write(pad([note(0)]))).toEqual([{ pitch: 36, vel: 80, start: 0, len: 120 }]);
  });

  it('accent_velocity_120_80', () => {
    const adds = write(pad([note(0, { accent: true }), note(3, { oct: 1 }), note(11, { oct: -1, accent: true })]));
    expect(adds.map((a) => a.vel)).toEqual([120, 80, 120]);
    expect(adds.map((a) => a.pitch)).toEqual([36, 51, 35]);
    expect(adds.map((a) => a.start)).toEqual([0, 240, 480]);
  });

  it('tie_length', () => {
    expect(write(pad([note(0), tie(), tie()]))).toEqual([{ pitch: 36, vel: 80, start: 0, len: 600 }]);
  });

  it('slide_overlaps_next_by_60', () => {
    const adds = write(pad([note(0, { slide: true }), note(2)]));
    expect(adds[0]).toEqual({ pitch: 36, vel: 80, start: 0, len: 300 });
    expect(adds[1]).toEqual({ pitch: 38, vel: 80, start: 240, len: 120 });
  });

  it('slide_into_tie', () => {
    // note, tie, tie+slide, note: the note reaches step 3 (720) + 60.
    const adds = write(pad([note(0), tie(), tie(true), note(5)]));
    expect(adds[0].len).toBe(780);
    expect(readSteps(adds.map((a) => mk(a.start, a.len, a.pitch, a.vel)), 1)).toEqual(
      { ok: true, base: 36, steps: pad([note(0), tie(), tie(true), note(5)]) });
  });

  it('slide_before_rest_or_end_is_dropped', () => {
    // Before a rest: plain length.
    const a = write(pad([note(0, { slide: true })]));
    expect(a).toEqual([{ pitch: 36, vel: 80, start: 0, len: 120 }]);
    // On a tie before a rest: tie length.
    const b = write(pad([note(0), tie(true)]));
    expect(b).toEqual([{ pitch: 36, vel: 80, start: 0, len: 360 }]);
    // On the last step of the pattern.
    const c = write([...Array.from({ length: 15 }, () => REST), note(0, { slide: true })]);
    expect(c).toEqual([{ pitch: 36, vel: 80, start: 15 * 240, len: 120 }]);
    for (const adds of [a, b, c]) {
      const view = readSteps(adds.map((x) => mk(x.start, x.len, x.pitch, x.vel)), 1);
      expect(view.ok && view.steps.some((s) => s.slide)).toBe(false);
    }
  });

  it('normalizes ties: no note before → rest; tie carries no pitch or accent', () => {
    const steps = normalizeSteps(
      [{ kind: 'tie', key: 4, oct: 1, accent: true, slide: false }, note(0), { kind: 'tie', key: 4, oct: 1, accent: true, slide: false }, REST, tie()],
      1);
    expect(steps.slice(0, 5)).toEqual([REST, note(0), tie(), REST, REST]);
    expect(steps).toHaveLength(16);
  });

  it('stepPitch is base + key + 12·oct', () => {
    expect(stepPitch(36, note(0))).toBe(36);
    expect(stepPitch(36, note(11, { oct: 1 }))).toBe(59);
    expect(stepPitch(48, note(0, { oct: -1 }))).toBe(36);
  });
});

// --- editing -----------------------------------------------------------------

describe('acid steps: editing', () => {
  it('untouched_notes_keep_lengths', () => {
    // A pattern from the piano roll: lengths 240, 480 and a slide overlapping by 30.
    const notes = [mk(0, 240, 36, 80, 'a'), mk(480, 480, 38, 80, 'b'), mk(960, 270, 40, 80, 'c'), mk(1200, 120, 41, 80, 'd')];
    const view = readSteps(notes, 1);
    const read = pad([note(0), REST, note(2), tie(), note(4, { slide: true }), note(5)]);
    expect(view).toEqual({ ok: true, base: 36, steps: read });

    const next = read.slice();
    next[0] = { ...next[0], accent: true };
    expect(planEdit(notes, 1, 36, next)).toEqual({ add: [], update: [{ id: 'a', vel: 120 }], remove: [] });
  });

  it('a pitch change of the note after a run does not touch the run', () => {
    const notes = [mk(0, 270, 36, 80, 'a'), mk(240, 120, 38, 80, 'b')];
    const next = pad([note(0, { slide: true }), note(7)]);
    expect(planEdit(notes, 1, 36, next)).toEqual({ add: [], update: [{ id: 'b', pitch: 43 }], remove: [] });
  });

  it('rest_after_slide_shrinks_previous', () => {
    const notes = [mk(0, 300, 36, 80, 'a'), mk(240, 120, 38, 80, 'b')];
    expect(readSteps(notes, 1)).toEqual({ ok: true, base: 36, steps: pad([note(0, { slide: true }), note(2)]) });
    // Step 1 becomes a rest; step 0 keeps its slide flag in the UI's list, but it can't be stored.
    const d = planEdit(notes, 1, 36, pad([note(0, { slide: true }), REST]));
    expect(d).toEqual({ add: [], update: [{ id: 'a', len: 120 }], remove: ['b'] });
    // The same with a tie before the slide: back to the tie length.
    const tied = [mk(0, 540, 36, 80, 'a'), mk(480, 120, 38, 80, 'b')];
    expect(planEdit(tied, 1, 36, pad([note(0), tie(true), REST]))).toEqual(
      { add: [], update: [{ id: 'a', len: 360 }], remove: ['b'] });
  });

  it('a tie added to a run rewrites the run note length; a note over a tie is added', () => {
    const notes = [mk(0, 120, 36, 80, 'a')];
    expect(planEdit(notes, 1, 36, pad([note(0), tie()]))).toEqual(
      { add: [], update: [{ id: 'a', len: 360 }], remove: [] });
    const tied = [mk(0, 360, 36, 80, 'a')];
    expect(planEdit(tied, 1, 36, pad([note(0), note(4)]))).toEqual(
      { add: [{ pitch: 40, vel: 80, start: 240, len: 120 }], update: [{ id: 'a', len: 120 }], remove: [] });
  });

  it('a kept slide that would overlap the note after next is shortened', () => {
    // 'a' slides into 'b' and runs to tick 1000, which is fine while the next note is at step 5.
    const notes = [mk(0, 1000, 36, 80, 'a'), mk(240, 120, 38, 80, 'b'), mk(1200, 120, 40, 80, 'c')];
    expect(readSteps(notes, 1).ok).toBe(true);
    // A new note at step 2 would make 'a' polyphonic, so its length is rewritten (still a slide).
    const d = planEdit(notes, 1, 36, pad([note(0, { slide: true }), note(2), note(4), REST, REST, note(4)]));
    expect(d).toEqual({ add: [{ pitch: 40, vel: 80, start: 480, len: 120 }], update: [{ id: 'a', len: 300 }], remove: [] });
    expect(readSteps(apply(notes, d), 1)).toEqual(
      { ok: true, base: 36, steps: pad([note(0, { slide: true }), note(2), note(4), REST, REST, note(4)]) });
  });

  it('notes_past_end_ignored', () => {
    // bars 3 → 48 steps; a note at step 50 is neither shown nor touched.
    const far = mk(50 * 240, 120, 100, 80, 'far');
    const notes = [mk(0, 120, 36, 80, 'a'), far];
    const view = readSteps(notes, 3);
    expect(view.ok && view.steps.length).toBe(48);
    expect(view).toEqual({ ok: true, base: 36, steps: pad([note(0)], 3) });
    const d = planEdit(notes, 3, 36, pad([], 3));
    expect(d).toEqual({ add: [], update: [], remove: ['a'] });
  });

  it('an unreadable pattern is replaced: every shown note goes, past-end notes stay', () => {
    const notes = [mk(100, 120, 36, 80, 'x'), mk(16 * 240, 120, 36, 80, 'far')];
    const d = planEdit(notes, 1, 36, pad([note(0)]));
    expect(d).toEqual({ add: [{ pitch: 36, vel: 80, start: 0, len: 120 }], update: [], remove: ['x'] });
  });
});

// --- reading -----------------------------------------------------------------

describe('acid steps: reading', () => {
  it('reads accents at vel ≥ 110 and covers ceil(len/240) steps', () => {
    // 100 is the app's default velocity (QWERTY, drawn notes): plain.
    const notes = [mk(0, 241, 36, 110), mk(960, 240, 38, 109), mk(1200, 120, 40, 100)];
    expect(readSteps(notes, 1)).toEqual(
      { ok: true, base: 36, steps: pad([note(0, { accent: true }), tie(), REST, REST, note(2), note(4)]) });
  });

  it('a note ending exactly at the next start is not a slide', () => {
    const notes = [mk(0, 240, 36), mk(240, 120, 38)];
    expect(readSteps(notes, 1)).toEqual({ ok: true, base: 36, steps: pad([note(0), note(2)]) });
  });

  it('coverage is capped at the pattern end', () => {
    const notes = [mk(14 * 240, 2000, 36)];
    expect(readSteps(notes, 1)).toEqual(
      { ok: true, base: 36, steps: [...Array.from({ length: 14 }, () => REST), note(0), tie()] });
  });

  it('offgrid', () => {
    expect(readSteps([mk(100, 120)], 1)).toEqual({ ok: false, reason: 'offgrid' });
  });
  it('chord', () => {
    expect(readSteps([mk(0, 120, 36), mk(0, 120, 40)], 1)).toEqual({ ok: false, reason: 'chord' });
  });
  it('poly', () => {
    // The first note covers the start of the note after next (step 2).
    expect(readSteps([mk(0, 600, 36), mk(240, 120, 38), mk(480, 120, 40)], 1)).toEqual({ ok: false, reason: 'poly' });
  });
  it('range', () => {
    expect(readSteps([mk(0, 120, 36), mk(240, 120, 100)], 1)).toEqual({ ok: false, reason: 'range' });
  });
  it('long', () => {
    expect(readSteps([], 5)).toEqual({ ok: false, reason: 'long' });
  });
  it('reason precedence: long > offgrid > chord > poly > range', () => {
    const offgridChord = [mk(100, 120), mk(0, 120, 36), mk(0, 120, 40, 80), mk(240, 120, 100)];
    expect(readSteps(offgridChord, 5)).toEqual({ ok: false, reason: 'long' });
    expect(readSteps(offgridChord, 1)).toEqual({ ok: false, reason: 'offgrid' });
    expect(readSteps(offgridChord.slice(1), 1)).toEqual({ ok: false, reason: 'chord' });
    const polyRange = [mk(0, 600, 36), mk(240, 120, 38), mk(480, 120, 100)];
    expect(readSteps(polyRange, 1)).toEqual({ ok: false, reason: 'poly' });
  });

  it('base_fits_lowest', () => {
    expect(readSteps([mk(0, 120, 24), mk(240, 120, 40)], 1)).toMatchObject({ ok: true, base: 36 });
    // 20 is below 36's window (24..59): 12·floor(20/12)+12 = 24 fits 12..47.
    expect(readSteps([mk(0, 120, 20), mk(240, 120, 40)], 1)).toMatchObject({ ok: true, base: 24 });
    // A given base that fits is kept.
    expect(readSteps([mk(0, 120, 50)], 1, 48)).toMatchObject({ ok: true, base: 48 });
    // A given base that doesn't fit falls through to the auto-fit bases.
    expect(readSteps([mk(0, 120, 50), mk(240, 120, 70)], 1, 24)).toMatchObject({ ok: true, base: 60 });
    expect(readSteps([mk(0, 120, 37), mk(240, 120, 70)], 1, 24)).toMatchObject({ ok: true, base: 48 });
  });

  it('empty pattern reads as rests at the given base', () => {
    expect(readSteps([], 2, 48)).toEqual({ ok: true, base: 48, steps: pad([], 2) });
  });
});

// --- convert -----------------------------------------------------------------

describe('acid steps: convert', () => {
  it('convert_snaps_and_folds', () => {
    const notes = [
      mk(100, 120, 36, 110), // snaps to step 0, accent
      mk(250, 200, 30), // chord on step 1: lower, dropped
      mk(230, 200, 90), // chord on step 1: highest kept, folded into the window
      mk(5 * 240 + 10, 2000, 50), // snaps to step 5, long: ties to the end
      mk(70 * 240, 120, 40), // past 64 steps: dropped
    ];
    const conv = convertSteps(notes, 5);
    expect(conv.steps).toHaveLength(64);
    const lo = conv.base - 12;
    const hi = conv.base + 23;
    for (const s of conv.steps) if (s.kind === 'note') expect(stepPitch(conv.base, s)).toBeGreaterThanOrEqual(lo);
    for (const s of conv.steps) if (s.kind === 'note') expect(stepPitch(conv.base, s)).toBeLessThanOrEqual(hi);
    expect(conv.base).toBe(36);
    expect(conv.steps.slice(0, 15)).toEqual([
      note(0, { accent: true }), note(6, { oct: 1 }), REST, REST, REST, note(2, { oct: 1 }),
      tie(), tie(), tie(), tie(), tie(), tie(), tie(), tie(), REST,
    ]);
    // 90 folds by octaves to 54 = 36 + 6 + 12.
    expect(stepPitch(conv.base, conv.steps[1])).toBe(54);

    // Writing the converted steps then reads them back exactly.
    const d = planEdit(notes, 4, conv.base, conv.steps);
    const after = apply(notes, d);
    expect(readSteps(after, 4, conv.base)).toEqual({ ok: true, base: conv.base, steps: conv.steps });
  });

  it('convert_clamps_start_rounding_to_end', () => {
    // 3830 rounds to step 16 of a 1-bar pattern: it must land on step 15, not vanish.
    const notes = [mk(3830, 100, 40), mk(3700, 100, 44)];
    const conv = convertSteps(notes, 1);
    expect(conv.steps[15].kind).toBe('note');
    expect(stepPitch(conv.base, conv.steps[15])).toBe(44); // highest of the two wins
    expect(conv.steps.filter((s) => s.kind === 'note')).toHaveLength(1);
  });

  it('convert keeps a readable pattern as it reads', () => {
    const notes = [mk(0, 300, 36), mk(240, 120, 38, 120)];
    const view = readSteps(notes, 1);
    expect(convertSteps(notes, 1)).toEqual(view.ok && { base: view.base, steps: view.steps });
  });
});

// --- property ----------------------------------------------------------------

describe('acid steps: edit property', () => {
  it('random_edits_read_back_and_keep_notes_past_end', () => {
    const rnd = mulberry32(2024);
    for (let it = 0; it < 600; it++) {
      const bars = 1 + (it % 4);
      const base = [24, 36, 48, 60][it % 4];
      const n = bars * 16;
      // A piano-roll-like readable pattern: canonical notes, then random lengths
      // (capped at next start + 30 so it stays readable) and velocities.
      const notes = write(randomSteps(rnd, n), bars, base).map((a) => mk(a.start, a.len, a.pitch, a.vel));
      notes.sort((a, b) => a.start - b.start);
      notes.forEach((m, k) => {
        if (rnd() < 0.5) return;
        const gap = (notes[k + 1]?.start ?? n * 240) - m.start;
        m.len = 1 + Math.floor(rnd() * (gap + 30));
        m.vel = 1 + Math.floor(rnd() * 127);
      });
      // Off-grid, chord-ish junk past the end must stay untouched.
      const past = [mk(n * 240 + Math.floor(rnd() * 500), 77, 5), mk(n * 240 + 240, 50, 120)];
      const all = [...notes, ...past];
      const before = readSteps(all, bars, base);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const steps = before.steps.map((s) => ({ ...s }));
      const muts = 1 + Math.floor(rnd() * 5);
      for (let m = 0; m < muts; m++) steps[Math.floor(rnd() * n)] = randomSteps(rnd, 1)[0];
      const diff = planEdit(all, bars, before.base, steps);
      const after = apply(all, diff);
      expect(readSteps(after, bars, before.base)).toEqual({ ok: true, base: before.base, steps: normalizeSteps(steps, bars) });
      for (const q of past) expect(after.find((x) => x.id === q.id)).toEqual(q);
    }
  });
});
