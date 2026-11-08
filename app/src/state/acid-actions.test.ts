import { describe, expect, it } from 'vitest';
import { createHistory, debugStacks } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { applyAcidSteps, convertToSteps, transposeAcid } from './acid-actions';
import { readSteps, REST, type AcidStep } from './acidSteps';
import { addNote, setPatternBars } from './pattern-actions';
import { Project, currentPattern } from './project.svelte';
import { addSynthTrack } from './rack-actions';

function setup() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const t = addSynthTrack(p, sink)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  p.history = h;
  sent.length = 0;
  return { p, t, sink, sent, h, entries: () => debugStacks(h).undo.length };
}

const note = (key: number, extra: Partial<AcidStep> = {}): AcidStep =>
  ({ kind: 'note', key, oct: 0, accent: false, slide: false, ...extra });
const pad = (head: AcidStep[], bars = 1): AcidStep[] =>
  [...head, ...Array.from({ length: bars * 16 - head.length }, () => REST)];

describe('acid actions', () => {
  it('apply_one_undo_entry', () => {
    const { p, t, sink, h, entries } = setup();
    expect(applyAcidSteps(p, sink, t.id, 36, pad([note(0), note(3, { accent: true }), note(7)]), 'Randomize steps')).toBe(true);
    expect(currentPattern(t).notes).toHaveLength(3);
    expect(entries()).toBe(1);
    expect(h.labels.undo).toBe('Randomize steps');
    // A mixed diff (remove + update + add) is still one entry, and undo restores the notes.
    const before = currentPattern(t).notes.map((n) => ({ ...n }));
    expect(applyAcidSteps(p, sink, t.id, 36, pad([note(5), REST, note(3), note(7), note(9)]), 'Mutate steps')).toBe(true);
    expect(entries()).toBe(2);
    h.undo();
    expect(currentPattern(t).notes.map((n) => [n.pitch, n.vel, n.start, n.len]).sort())
      .toEqual(before.map((n) => [n.pitch, n.vel, n.start, n.len]).sort());
  });

  it('empty_diff_sends_nothing', () => {
    const { p, t, sink, sent, entries } = setup();
    const steps = pad([note(0)]);
    applyAcidSteps(p, sink, t.id, 36, steps, 'x');
    sent.length = 0;
    expect(applyAcidSteps(p, sink, t.id, 36, steps, 'x')).toBe(false);
    expect(sent).toEqual([]);
    expect(entries()).toBe(1);
  });

  it('refused_when_unreadable_or_other_base', () => {
    const { p, t, sink, sent, entries } = setup();
    addNote(p, sink, t.id, { pitch: 50, start: 100, len: 50 }); // off the grid
    const n = entries();
    sent.length = 0;
    expect(applyAcidSteps(p, sink, t.id, 36, pad([note(0)]), 'x')).toBe(false);
    expect(sent).toEqual([]);
    expect(entries()).toBe(n);
    // Readable only at an auto-fitted base: an edit at another base is refused.
    const q = setup();
    addNote(q.p, q.sink, q.t.id, { pitch: 90, start: 0, len: 100 });
    q.sent.length = 0;
    expect(applyAcidSteps(q.p, q.sink, q.t.id, 36, pad([note(0)]), 'x')).toBe(false);
    expect(q.sent).toEqual([]);
  });

  it('coalesced_toggles_merge', () => {
    const { p, t, sink, entries } = setup();
    applyAcidSteps(p, sink, t.id, 36, pad([note(0), note(2)]), 'Randomize steps');
    expect(entries()).toBe(1);
    applyAcidSteps(p, sink, t.id, 36, pad([note(0, { accent: true }), note(2)]), 'Accent', 'accent');
    applyAcidSteps(p, sink, t.id, 36, pad([note(0, { accent: true }), note(2, { accent: true })]), 'Accent', 'accent');
    expect(entries()).toBe(2);
    // A different kind starts a new entry.
    applyAcidSteps(p, sink, t.id, 36, pad([note(1, { accent: true }), note(2, { accent: true })]), 'Pitch', 'pitch');
    expect(entries()).toBe(3);
  });

  it('transpose_whole_pattern', () => {
    const { p, t, sink, entries } = setup();
    addNote(p, sink, t.id, { pitch: 40, start: 0, len: 100 });
    addNote(p, sink, t.id, { pitch: 50, start: 5 * 3840, len: 100 }); // past the end: moves too
    const n = entries();
    expect(transposeAcid(p, sink, t.id, 7)).toBe(true);
    expect(currentPattern(t).notes.map((x) => x.pitch)).toEqual([47, 57]);
    expect(entries()).toBe(n + 1);
    expect(transposeAcid(p, sink, t.id, -7)).toBe(true);
    expect(currentPattern(t).notes.map((x) => x.pitch)).toEqual([40, 50]);
  });

  it('transpose_refused_at_127', () => {
    const { p, t, sink, sent, entries } = setup();
    addNote(p, sink, t.id, { pitch: 120, start: 0, len: 100 });
    addNote(p, sink, t.id, { pitch: 60, start: 240, len: 100 });
    const n = entries();
    sent.length = 0;
    expect(transposeAcid(p, sink, t.id, 12)).toBe(false);
    expect(currentPattern(t).notes.map((x) => x.pitch)).toEqual([120, 60]);
    expect(sent).toEqual([]);
    expect(entries()).toBe(n);
    expect(transposeAcid(p, sink, t.id, -61)).toBe(false); // 60 would go below 0
  });

  it('convert_is_one_entry_and_readable', () => {
    const { p, t, sink, h, entries } = setup();
    setPatternBars(p, sink, t.id, 6);
    addNote(p, sink, t.id, { pitch: 40, start: 100, len: 100 });
    addNote(p, sink, t.id, { pitch: 43, start: 250, len: 100 }); // snaps to step 1
    addNote(p, sink, t.id, { pitch: 45, start: 250, len: 100 }); // chord on step 1
    addNote(p, sink, t.id, { pitch: 47, start: 5 * 3840, len: 100 }); // past 4 bars: kept
    expect(readSteps(currentPattern(t).notes, currentPattern(t).bars).ok).toBe(false);
    const n = entries();
    const base = convertToSteps(p, sink, t.id);
    const pat = currentPattern(t);
    expect(entries()).toBe(n + 1);
    expect(h.labels.undo).toBe('Convert to steps');
    expect(pat.bars).toBe(4);
    const view = readSteps(pat.notes, pat.bars, base);
    expect(view.ok).toBe(true);
    expect(pat.notes.some((x) => x.pitch === 47 && x.start === 5 * 3840)).toBe(true);
    h.undo();
    expect(currentPattern(t).bars).toBe(6);
    expect(currentPattern(t).notes).toHaveLength(4);
  });
});
