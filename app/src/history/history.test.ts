import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { addDrumTrack, removeTrack, setTempo, toggleStep } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { mixParam } from '../audio/mixerCatalog';
import { addNote } from '../state/pattern-actions';
import { addSynthTrack } from '../state/rack-actions';
import { Project, currentPattern } from '../state/project.svelte';
import type { DrumTrack } from '../state/project.svelte';
import { serialize } from '../project/serialize';
import { createHistory } from './history';
import { diffApply } from './diffApply';

/** A project with one drum track, its history installed as App does it. */
function setup(opts: { coalesceTask?: boolean; cap?: number } = {}) {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  const d = addDrumTrack(p, sink)!;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to), ...opts });
  p.history = h;
  sent.length = 0;
  const step = (s: number) => currentPattern(p.tracks[0] as DrumTrack).steps[0][s];
  return { p, sink, sent, h, d, step, toggle: (s: number) => toggleStep(p, sink, d.id, d.rows[0].id, s) };
}

describe('history', () => {
  it('undo/redo of a step toggle', () => {
    const s = setup();
    expect(s.h.canUndo).toBe(false);
    s.toggle(3);
    expect(s.step(3)).toBe(100);
    expect(s.h.canUndo).toBe(true);
    expect(s.h.labels).toEqual({ undo: 'Toggle step', redo: null });
    s.sent.length = 0;
    expect(s.h.undo()).toBe(true);
    expect(s.step(3)).toBe(0);
    expect(s.sent).toEqual([[Op.SET_STEP, s.d.slot, 0, 3, 0]]);
    expect(s.h.labels).toEqual({ undo: null, redo: 'Toggle step' });
    expect(s.h.undo()).toBe(false); // nothing left
    s.sent.length = 0;
    expect(s.h.redo()).toBe(true);
    expect(s.step(3)).toBe(100);
    expect(s.sent).toEqual([[Op.SET_STEP, s.d.slot, 0, 3, 100]]);
    expect(s.h.redo()).toBe(false);
  });

  it('drag coalesces', () => {
    const s = setup();
    const fader = mixParam('fader').id;
    s.h.begin(); // pointerdown on the fader
    for (let v = -1; v >= -20; v--) setMix(s.p, s.sink, s.d.id, 'fader', v);
    s.h.commit(); // pointerup
    expect(s.h.labels.undo).toBe('Set Volume');
    s.sent.length = 0;
    s.h.undo();
    expect(s.p.mixer.channels[s.d.id].params[fader]).toBe(0);
    expect(s.sent).toEqual([[Op.MIX_SET, s.d.slot, fader, 0, 0]]);
    expect(s.h.canUndo).toBe(false); // the whole drag was one entry
    // A gesture that edits nothing (a click on empty space) leaves no entry.
    s.h.begin();
    s.h.commit();
    expect(s.h.canUndo).toBe(false);
    // A drag that ends where it started (Escape restores the value) neither.
    s.h.begin();
    setMix(s.p, s.sink, s.d.id, 'fader', -5);
    setMix(s.p, s.sink, s.d.id, 'fader', 0);
    s.h.commit();
    expect(s.h.canUndo).toBe(false);
  });

  it('new edit clears redo', () => {
    const s = setup();
    s.toggle(1);
    s.toggle(2);
    s.h.undo();
    expect(s.h.canRedo).toBe(true);
    s.toggle(5);
    expect(s.h.canRedo).toBe(false);
    expect([s.step(1), s.step(2), s.step(5)]).toEqual([100, 0, 100]);
    s.h.undo();
    s.h.undo();
    expect([s.step(1), s.step(2), s.step(5)]).toEqual([0, 0, 0]);
  });

  it('cap 200', () => {
    const s = setup();
    for (let i = 0; i < 205; i++) setTempo(s.p, s.sink, 30 + i);
    let n = 0;
    while (s.h.undo()) n++;
    expect(n).toBe(200);
    expect(s.p.tempo).toBe(30 + 4); // the 5 oldest edits fell off
    expect(createHistory({ snapshot: () => serialize(s.p), apply: () => {}, cap: 3 })).toBeTruthy();
  });

  it('nested actions are one entry under the outer label', () => {
    const s = setup();
    addSynthTrack(s.p, s.sink); // ADD + bars + loadPatch + selectTrack inside
    expect(s.h.labels.undo).toBe('Add synth track');
    s.h.undo();
    expect(s.p.tracks).toHaveLength(1);
    expect(s.h.canUndo).toBe(false);
  });

  it('a selection is not an entry; an edit that changes nothing is not either', () => {
    const s = setup();
    setTempo(s.p, s.sink, s.p.tempo);
    expect(s.h.canUndo).toBe(false);
  });

  it('undo marks the project edited (dirty, version) through the command sink', () => {
    const s = setup();
    s.toggle(0);
    s.p.dirty = false;
    const v = s.p.version;
    s.h.undo();
    expect(s.p.dirty).toBe(true);
    expect(s.p.version).toBeGreaterThan(v);
  });

  it('undo and redo are refused while a load replaces the session; clear forgets everything', () => {
    const p = new Project();
    let loading = false;
    const h = createHistory({ snapshot: () => serialize(p), apply: () => {}, canApply: () => !loading });
    p.history = h;
    addDrumTrack(p, { send: () => true });
    loading = true;
    expect(h.undo()).toBe(false);
    loading = false;
    h.clear();
    expect([h.canUndo, h.canRedo]).toEqual([false, false]);
  });

  it('a coalesce key merges consecutive entries (one recording pass)', () => {
    const s = setup();
    const t = addSynthTrack(s.p, s.sink)!;
    for (let i = 0; i < 3; i++) s.h.transact('Record', () => addNote(s.p, s.sink, t.id, { pitch: 60 + i, start: i * 240, len: 100 }), { coalesce: 'rec:1' });
    s.h.transact('Record', () => addNote(s.p, s.sink, t.id, { pitch: 70, start: 0, len: 100 }), { coalesce: 'rec:2' });
    expect(currentPattern(t).notes).toHaveLength(4);
    s.h.undo(); // pass 2
    expect(currentPattern(t).notes).toHaveLength(3);
    s.h.undo(); // pass 1, all three notes
    expect(currentPattern(t).notes).toHaveLength(0);
    expect(s.h.labels.undo).toBe('Add synth track');
  });

  it('coalesceTask: edits in one task (a paste loop, one key press) are one entry', async () => {
    const s = setup({ coalesceTask: true });
    s.toggle(0);
    s.toggle(1);
    s.toggle(2);
    await Promise.resolve();
    s.toggle(3); // a later task
    s.h.undo();
    expect([0, 1, 2, 3].map(s.step)).toEqual([100, 100, 100, 0]);
    s.h.undo();
    expect([0, 1, 2, 3].map(s.step)).toEqual([0, 0, 0, 0]);
  });

  it('undo during an open gesture commits it first', () => {
    const s = setup();
    s.h.begin();
    s.toggle(4);
    s.h.undo();
    expect(s.step(4)).toBe(0);
    s.h.commit(); // the pointerup after: nothing more
    expect(s.h.canUndo).toBe(false);
    expect(s.h.canRedo).toBe(true);
  });

  it('removing a track and undoing it restores the track in its slot', () => {
    const s = setup();
    removeTrack(s.p, s.sink, s.d.id);
    expect(s.h.labels.undo).toBe('Remove track');
    s.sent.length = 0;
    s.h.undo();
    expect(s.p.tracks.map((t) => t.slot)).toEqual([s.d.slot]);
    expect(s.sent[0]).toEqual([Op.ADD_DRUM_TRACK, s.d.slot, 0, 0, 0]);
  });
});
