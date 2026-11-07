import { describe, expect, it, vi } from 'vitest';
import { Op } from '../audio/protocol';
import { addDrumTrack, play, removeTrack, selectTrack, setTempo, toggleStep } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { mixParam } from '../audio/mixerCatalog';
import { addNote, deleteNotes, newPattern, selectPattern } from '../state/pattern-actions';
import { edit } from '../state/edits';
import { recorderFor } from '../state/recorder';
import { addSynthTrack } from '../state/rack-actions';
import { Project, currentPattern } from '../state/project.svelte';
import type { DrumTrack, SynthTrack } from '../state/project.svelte';
import type { ProjectJson, SynthTrackJson } from '../project/schema';
import { serialize } from '../project/serialize';
import { createHistory } from './history';
import { diffApply } from './diffApply';
import { banners } from '../state/banners.svelte';
import { createDirtyCheck } from '../project/dirtyCheck';
import { markSaved } from '../project/session';

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

  it('an apply that throws clears the history and raises an error banner', () => {
    const p = new Project();
    addDrumTrack(p, { send: () => true });
    let fail = false;
    const sink = { send: () => true };
    const h = createHistory({
      snapshot: () => serialize(p),
      apply: (from, to) => { if (fail) throw new Error('boom'); diffApply(p, sink, from, to); },
    });
    p.history = h;
    const d = p.tracks[0] as DrumTrack;
    toggleStep(p, sink, d.id, d.rows[0].id, 2);
    banners.error = null;
    fail = true;
    expect(h.undo()).toBe(false);
    expect(banners.error).toBe('Undo failed \u2014 history cleared');
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    banners.error = null;
  });

  it('undo back to the saved state settles dirty to false (edit, save, edit, undo)', async () => {
    const s = setup();
    s.toggle(1);
    markSaved(s.p);
    s.toggle(2);
    expect(s.h.undo()).toBe(true);
    expect(s.p.dirty).toBe(true); // marked at once ...
    createDirtyCheck(s.p, { idle: (fn) => fn(), delayMs: 0 }).poke();
    await new Promise((r) => setTimeout(r, 5));
    expect(s.p.dirty).toBe(false); // ... settled by the fingerprint check
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

  it('undoKey names the newest entry\'s coalesce key (Undo take keys off it, not the label)', () => {
    const s = setup();
    const t = addSynthTrack(s.p, s.sink)!;
    expect(s.h.undoKey).toBeNull();
    s.h.transact('Record', () => addNote(s.p, s.sink, t.id, { pitch: 60, start: 0, len: 10 }), { coalesce: 'rec:7' });
    expect(s.h.undoKey).toBe('rec:7');
    s.h.transact('Record', () => setTempo(s.p, s.sink, 99)); // same label, no key: not a pass
    expect(s.h.undoKey).toBeNull();
  });

  it('a transact that merges into the newest entry takes no before-snapshot', () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addSynthTrack(p, sink)!;
    let snaps = 0;
    const h = createHistory({ snapshot: () => (snaps++, serialize(p)), apply: (f, to) => diffApply(p, sink, f, to) });
    p.history = h;
    h.transact('Record', () => addNote(p, sink, t.id, { pitch: 60, start: 0, len: 10 }), { coalesce: 'rec:1' });
    expect(snaps).toBe(2); // before + after
    for (let i = 1; i <= 5; i++) h.transact('Record', () => addNote(p, sink, t.id, { pitch: 60 + i, start: 0, len: 10 }), { coalesce: 'rec:1' });
    expect(snaps).toBe(2); // and no "after" either: it is taken lazily (plan 8)
    h.undo();
    expect(currentPattern(t).notes).toEqual([]);
  });

  it('undo / redo with nothing to apply does not run beforeApply', () => {
    let calls = 0;
    const p = new Project();
    const h = createHistory({ snapshot: () => serialize(p), apply: () => {}, beforeApply: () => calls++ });
    expect([h.undo(), h.redo()]).toEqual([false, false]);
    expect(calls).toBe(0);
    p.history = h;
    setTempo(p, { send: () => true }, 90);
    h.undo();
    expect(calls).toBe(1);
  });
});


// Plan 8 Task 2: lean history (lazy recording "after", shared, frozen snapshots).
describe('lean history', () => {
  /** n tracks (synths first), history installed; `snaps` counts snapshot() calls, `applied` every target. */
  function big(nSynth: number, nDrum: number) {
    const sent: number[][] = [];
    const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
    const p = new Project();
    const synths = Array.from({ length: nSynth }, () => addSynthTrack(p, sink)!);
    const drums = Array.from({ length: nDrum }, () => addDrumTrack(p, sink)!);
    const stats = { snaps: 0 };
    const applied: ProjectJson[] = [];
    const clock = { now: 0, heardTicks: () => clock.now, ticksForEvent: (ms: number, off: number) => ms - off };
    const rec = recorderFor(p, sink, clock);
    p.beforePatternSwitch = (id) => rec.onPatternChanging(id, clock.heardTicks());
    const h = createHistory({
      snapshot: () => (stats.snaps++, serialize(p)),
      apply: (from, to) => (applied.push(to), diffApply(p, sink, from, to)),
      beforeApply: () => rec.onInputChanged(clock.heardTicks()),
    });
    p.history = h;
    sent.length = 0;
    return { p, sink, sent, synths, drums, stats, applied, clock, rec, h };
  }
  const notesOf = (t: SynthTrack) => currentPattern(t).notes.map((n) => [n.pitch, n.start, n.len]);

  it('recording 500 notes does not serialize per note', () => {
    const s = big(16, 16); // a 32-track project
    const t = s.synths[0];
    const stringify = vi.spyOn(JSON, 'stringify');
    for (let i = 0; i < 500; i++) {
      edit(s.p, 'Record', () => addNote(s.p, s.sink, t.id, { pitch: 40 + (i % 40), start: i * 7, len: 5 }), { coalesce: 'rec:1' });
    }
    // The pass's "before" and the first note's "after": nothing per note after that.
    expect(s.stats.snaps).toBeLessThanOrEqual(2);
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(2);
    stringify.mockRestore();
    expect(s.h.labels.undo).toBe('Record');
    s.h.undo();
    expect(currentPattern(t).notes).toEqual([]);
    expect(s.h.canUndo).toBe(false);
    s.h.redo();
    expect(currentPattern(t).notes).toHaveLength(500);
  });

  it('lazy after: undo mid-playback', () => {
    const s = big(1, 1);
    const t = s.synths[0];
    selectTrack(s.p, s.sink, t.id); // the live input
    play(s.p, s.sink);
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    const pre = serialize(s.p);
    const snaps0 = s.stats.snaps;
    for (let i = 0; i < 20; i++) {
      s.rec.noteOn(60 + i, 100, i * 100 + 10);
      s.rec.noteOff(60 + i, i * 100 + 60);
    }
    s.rec.noteOn(90, 100, 3000); // still held when undo comes
    s.clock.now = 3200;
    expect(s.stats.snaps - snaps0).toBeLessThanOrEqual(2); // the pass's after was never materialised
    s.sent.length = 0;
    expect(s.h.undo()).toBe(true); // closes the held note into the pass, then undoes it all
    expect(serialize(s.p)).toEqual(pre);
    expect(s.p.playing).toBe(true);
    expect(s.sent.map((c) => c[0])).not.toContain(Op.STOP);
    expect(s.sent.map((c) => c[0])).not.toContain(Op.RESET_ALL);
    expect(s.h.redo()).toBe(true);
    expect(currentPattern(t).notes).toHaveLength(21); // the 20 notes and the held one
    expect(notesOf(t).at(-1)).toEqual([90, 3000, 200]);
  });

  it('a pattern switch after a pass is not part of its after (redo lands where the last note did)', () => {
    const s = big(1, 0);
    const t = s.synths[0];
    newPattern(s.p, s.sink, t.id); // pattern 2, current
    const p2 = currentPattern(t).id;
    for (let i = 0; i < 3; i++) edit(s.p, 'Record', () => addNote(s.p, s.sink, t.id, { pitch: 60 + i, start: i * 10, len: 5 }), { coalesce: 'rec:1' });
    const atLastNote = serialize(s.p);
    selectPattern(s.p, s.sink, t.id, t.patterns[0].id); // not an edit, but saved
    s.h.undo();
    s.h.redo();
    expect(serialize(s.p)).toEqual(atLastNote);
    expect(t.currentPatternId).toBe(p2);
  });

  it('a lazily merged pass that ends where it started is dropped by the undo that names it', () => {
    const s = big(1, 0);
    const t = s.synths[0];
    const tempo = s.p.tempo;
    setTempo(s.p, s.sink, 100);
    edit(s.p, 'Record', () => addNote(s.p, s.sink, t.id, { pitch: 60, start: 0, len: 5 }), { coalesce: 'rec:1' });
    edit(s.p, 'Record', () => deleteNotes(s.p, s.sink, t.id, currentPattern(t).notes.map((n) => n.id)), { coalesce: 'rec:1' });
    expect(s.h.labels.undo).toBe('Record'); // stale: not known to be empty yet
    s.applied.length = 0;
    expect(s.h.undo()).toBe(true); // the pass goes; nothing is applied, the tempo edit stays
    expect(s.applied).toEqual([]);
    expect(s.p.tempo).toBe(100);
    expect(currentPattern(t).notes).toEqual([]);
    expect(s.h.labels).toEqual({ undo: 'Tempo', redo: null });
    expect(s.h.undo()).toBe(true);
    expect(s.p.tempo).toBe(tempo);
  });

  it('unchanged tracks are shared between snapshots', () => {
    const s = big(2, 2);
    const [s0, s1] = s.synths;
    const d0 = s.drums[0];
    addNote(s.p, s.sink, s0.id, { pitch: 60, start: 0, len: 10 }); // entry A: synth 0
    toggleStep(s.p, s.sink, d0.id, d0.rows[0].id, 3); // entry B: drum 0
    s.h.undo(); // applies B.before (= A.after)
    s.h.undo(); // applies A.before
    s.h.redo(); // A.after
    s.h.redo(); // B.after
    const [bBefore, aBefore, aAfter, bAfter] = s.applied;
    expect(aAfter).toBe(bBefore); // nothing happened between A and B: one object
    // A changed synth 0 only, B drum 0 only (slots: synths 0, 1; drums 2, 3).
    expect(aAfter.tracks[0]).not.toBe(aBefore.tracks[0]);
    for (const i of [1, 2, 3]) expect(aAfter.tracks[i]).toBe(aBefore.tracks[i]);
    expect(bAfter.tracks[2]).not.toBe(bBefore.tracks[2]);
    for (const i of [0, 1, 3]) expect(bAfter.tracks[i]).toBe(bBefore.tracks[i]);
    expect(bAfter.mixer).toBe(aBefore.mixer);
    // Inside a changed track, what did not change is shared too.
    expect(aAfter.tracks[0].kind === 'synth' && aAfter.tracks[0].patch).toBe(aBefore.tracks[0].kind === 'synth' && aBefore.tracks[0].patch);
    expect(s1.kind).toBe('synth');
    // A mixer edit shares the tracks and the other strips.
    setMix(s.p, s.sink, s1.id, 'fader', -3);
    s.h.undo();
    s.h.redo();
    const [mBefore, mAfter] = s.applied.slice(-2);
    expect(mAfter.tracks).toBe(mBefore.tracks);
    expect(mAfter.mixer).not.toBe(mBefore.mixer);
    expect(mAfter.mixer.tracks[0]).toBe(mBefore.mixer.tracks[0]);
    expect(mAfter.mixer.reverb).toBe(mBefore.mixer.reverb);
  });

  it('snapshots are frozen', () => {
    const s = big(1, 1);
    const t = s.synths[0];
    addNote(s.p, s.sink, t.id, { pitch: 60, start: 0, len: 10 });
    s.h.undo();
    s.h.redo();
    const [before, after] = s.applied;
    for (const snap of [before, after]) {
      const tj = snap.tracks[0] as SynthTrackJson;
      expect(() => { (snap as { tempo: number }).tempo = 1; }).toThrow(TypeError);
      expect(() => { snap.tracks.push(snap.tracks[0]); }).toThrow(TypeError);
      expect(() => { tj.name = 'x'; }).toThrow(TypeError);
      expect(() => { tj.patterns[0].notes.push({ idx: 9, pitch: 1, vel: 1, start: 0, len: 1 }); }).toThrow(TypeError);
      expect(() => { tj.patch.modules[0].params!.x = 1; }).toThrow(TypeError);
      expect(() => { snap.mixer.master.x = 1; }).toThrow(TypeError);
    }
    // The live project is never frozen (a snapshot shares nothing with it).
    addNote(s.p, s.sink, t.id, { pitch: 61, start: 0, len: 10 });
    setMix(s.p, s.sink, t.id, 'fader', -2);
    s.h.undo();
    s.h.undo();
    expect(notesOf(t)).toEqual([[60, 0, 10]]);
  });
  it('rebase: a starting-point change patches every stored state, so undo/redo keep it (plan 8 Task 4)', () => {
    const s = setup();
    s.toggle(1); // entry A
    s.toggle(2); // entry B
    s.h.undo(); // B on the redo stack
    s.h.begin(); // a gesture that has edited: its before is stored too
    s.toggle(5);
    // The change lands in the live project outside the history (the kit row's name here).
    const row = s.d.rows[1];
    row.name = 'Kick';
    const patch = (j: ProjectJson): ProjectJson => {
      const t = j.tracks[0];
      if (t.kind !== 'drum' || t.rows[1].name === 'Kick') return j;
      return { ...j, tracks: [{ ...t, rows: t.rows.map((r, i) => (i === 1 ? { ...r, name: 'Kick' } : r)) }] };
    };
    s.h.rebase(patch);
    s.h.commit(); // entry C (toggle 5)
    expect(s.h.undo()).toBe(true); // C
    expect(s.h.undo()).toBe(true); // A
    expect([s.step(1), s.step(2), s.step(5)]).toEqual([0, 0, 0]);
    expect(s.d.rows[1].name).toBe('Kick');
    s.h.redo(); // A
    s.h.redo(); // C (B was dropped by C)
    expect([s.step(1), s.step(5)]).toEqual([100, 100]);
    expect(s.d.rows[1].name).toBe('Kick');
  });

  it('rebase keeps snapshots shared and frozen', () => {
    const s = big(1, 1);
    const t = s.synths[0];
    addNote(s.p, s.sink, t.id, { pitch: 60, start: 0, len: 10 });
    addNote(s.p, s.sink, t.id, { pitch: 61, start: 0, len: 10 });
    s.p.tempo = 99; // the starting-point change (no command)
    s.h.rebase((j) => (j.tempo === 99 ? j : { ...j, tempo: 99 }));
    s.h.undo();
    s.h.undo();
    s.h.redo();
    const [b1, a0, a1] = s.applied; // B.before, A.before, A.after
    expect([b1.tempo, a0.tempo, a1.tempo]).toEqual([99, 99, 99]);
    expect(a1).toBe(b1); // A.after and B.before were one object, and still are
    expect(a1.mixer).toBe(a0.mixer); // unchanged subtrees still shared
    expect(() => { (a0 as { tempo: number }).tempo = 1; }).toThrow(TypeError);
    expect(s.p.tempo).toBe(99);
  });
});
