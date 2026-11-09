import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cancelDrags, createGestures, registerDragCancel } from './gestures';
import { createHistory } from './history';
import { diffApply } from './diffApply';
import { serialize } from '../project/serialize';
import { addDrumTrack, setStep, setStepVelocity, setTempo } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { Project, currentPattern } from '../state/project.svelte';

/**
 * A fake history logging begin/commit, and a manual one-task-later queue.
 * `drags`: the widgets' drag cancels (each true when it cancelled a drag).
 */
function setup(drags: (() => boolean)[] = []) {
  const log: string[] = [];
  const queue: (() => void)[] = [];
  let loading = false;
  const g = createGestures({
    history: () => ({ begin: () => log.push('begin'), commit: () => log.push('commit') }),
    loading: () => loading,
    later: (fn) => void queue.push(fn),
    cancelDrags: () => drags.map((c) => c()).some(Boolean),
  });
  const flush = () => queue.splice(0).forEach((fn) => fn());
  const down = (id = 1, isPrimary = true) => g.press({ pointerId: id, isPrimary });
  const up = (id = 1) => g.release({ pointerId: id });
  return { g, log, flush, down, up, setLoading: (v: boolean) => (loading = v) };
}

const select = { tagName: 'SELECT' } as unknown as EventTarget;
const text = { tagName: 'INPUT' } as unknown as EventTarget;

describe('gestures', () => {
  it('press .. release is one gesture, committed one task after the release', () => {
    const s = setup();
    s.down();
    s.up();
    expect(s.log).toEqual(['begin']);
    s.flush();
    expect(s.log).toEqual(['begin', 'commit']);
  });

  it('a lost pointerup (native popup) does not fuse the next press into the old gesture', () => {
    const s = setup();
    s.down(1); // opens a <select>: its pointerup never arrives
    s.down(1); // the next click elsewhere
    expect(s.log).toEqual(['begin', 'begin']); // begin() closes the stale gesture first
    s.up(1);
    s.flush();
    expect(s.log).toEqual(['begin', 'begin', 'commit']);
  });

  it('a <select> change ends the gesture its press opened, so the pick is its own entry', () => {
    const s = setup();
    s.down(1);
    s.g.change(select);
    expect(s.log).toEqual(['begin', 'commit']);
    s.down(2); // later presses begin anew
    expect(s.log).toEqual(['begin', 'commit', 'begin']);
  });

  it('a text field\'s change (blur by a press elsewhere) leaves that press\'s gesture alone', () => {
    const s = setup();
    s.down(1); // pressing a knob blurs the BPM field: change fires mid-press
    s.g.change(text);
    s.up(1);
    s.flush();
    expect(s.log).toEqual(['begin', 'commit']);
  });

  it('a context menu ends the gesture (its pointerup is swallowed)', () => {
    const s = setup();
    s.down(1);
    s.g.contextMenu();
    expect(s.log).toEqual(['begin', 'commit']);
    s.down(1);
    expect(s.log).toEqual(['begin', 'commit', 'begin']);
  });

  it('blur commits and forgets held pointers', () => {
    const s = setup();
    s.down(1);
    s.g.blur();
    s.down(1);
    expect(s.log).toEqual(['begin', 'commit', 'begin']);
  });

  it('a second (non-primary) pointer joins the gesture; it ends with the last release', () => {
    const s = setup();
    s.down(1);
    s.down(2, false);
    s.up(1);
    s.flush();
    expect(s.log).toEqual(['begin']);
    s.up(2);
    s.flush();
    expect(s.log).toEqual(['begin', 'commit']);
  });

  it('undo/redo mid-drag re-opens a gesture for the rest of the drag', () => {
    const s = setup();
    s.down(1);
    s.g.afterApply(); // Cmd+Z while the mouse is still down
    expect(s.log).toEqual(['begin', 'begin']);
    s.up(1);
    s.flush();
    s.g.afterApply(); // nothing held: nothing to re-open
    expect(s.log).toEqual(['begin', 'begin', 'commit']);
  });

  it('no gesture starts while a load replaces the session', () => {
    const s = setup();
    s.setLoading(true);
    s.down(1);
    expect(s.log).toEqual([]);
  });

  // Plan 16 Task 5: Cmd/Ctrl+Z (or redo) during a drag cancels the drag.
  it('undo/redo during a drag cancels it instead (no history call)', () => {
    let dragging = true;
    const cancelled: string[] = [];
    const s = setup([() => {
      if (!dragging) return false;
      dragging = false;
      cancelled.push('knob');
      return true;
    }]);
    s.down(1);
    expect(s.g.cancelDrag()).toBe(true); // App then neither undoes nor redoes
    expect(cancelled).toEqual(['knob']);
    expect(s.log).toEqual(['begin']); // the gesture stays open until the release
    // A held Cmd+Z repeats: still swallowed while the pointer is down (no undo of an older entry).
    expect(s.g.cancelDrag()).toBe(true);
    expect(cancelled).toEqual(['knob']);
    s.up(1);
    s.flush();
    expect(s.log).toEqual(['begin', 'commit']);
    // Released: Cmd+Z is a normal undo again.
    expect(s.g.cancelDrag()).toBe(false);
  });

  it('pointerDown follows the held pointers (shortcuts: Alt+undo only mid-drag)', () => {
    const s = setup();
    expect(s.g.pointerDown()).toBe(false);
    s.down(1);
    expect(s.g.pointerDown()).toBe(true);
    s.up(1);
    expect(s.g.pointerDown()).toBe(false);
    s.down(2);
    s.g.blur();
    expect(s.g.pointerDown()).toBe(false);
  });

  it('Cmd+Z with no drag in progress is a normal undo', () => {
    let calls = 0;
    const s = setup([() => (calls++, false)]);
    expect(s.g.cancelDrag()).toBe(false); // no pointer down: the widgets are not even asked
    expect(calls).toBe(0);
    s.down(1); // a press on something that is not a cancellable drag (a button)
    expect(s.g.cancelDrag()).toBe(false);
    expect(calls).toBe(1);
    s.up(1);
    s.flush();
    s.down(1); // a new press after a cancel starts clean
    expect(s.g.cancelDrag()).toBe(false);
  });

  it('the swallow ends with the gesture however it ends (blur, context menu)', () => {
    let dragging = true;
    const s = setup([() => (dragging ? ((dragging = false), true) : false)]);
    s.down(1);
    expect(s.g.cancelDrag()).toBe(true);
    s.g.blur();
    expect(s.g.cancelDrag()).toBe(false);
  });
});

describe('a key right after a release (plan 23 T1 review #1)', () => {
  it('commitReleased commits a released gesture at once, only once, and never mid-press', () => {
    const s = setup();
    s.g.commitReleased(); // nothing was pressed: nothing to commit
    expect(s.log).toEqual([]);
    s.down(1);
    s.g.commitReleased(); // still held: the press goes on
    expect(s.log).toEqual(['begin']);
    s.up(1);
    s.g.commitReleased(); // released, its commit still a task away: commit now
    expect(s.log).toEqual(['begin', 'commit']);
    s.g.commitReleased(); // already done
    expect(s.log).toEqual(['begin', 'commit']);
    s.flush(); // the release's own commit still runs (a no-op on a closed history)
    s.g.commitReleased();
    expect(s.log).toEqual(['begin', 'commit', 'commit']);
  });

  it('a step-velocity key after a click is its own entry, not part of the click\'s', () => {
    const sink = { send: () => true };
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    p.history = h;
    const queue: (() => void)[] = [];
    const g = createGestures({ history: () => h, loading: () => false, later: (fn) => void queue.push(fn) });
    const row = d.rows[0].id;
    g.press({ pointerId: 1, isPrimary: true });
    setStep(p, sink, d.id, row, 0, 100); // the click lights the step
    g.release({ pointerId: 1 });
    g.commitReleased(); // App's keydown capture, before the cell's key handler
    setStepVelocity(p, sink, d.id, row, 0, 105, { coalesce: 'k' }); // Shift+↑
    queue.splice(0).forEach((fn) => fn());
    expect(h.labels.undo).toBe('Step velocity');
    expect(h.undo()).toBe(true);
    expect(currentPattern(d).steps[0][0]).toBe(100); // still lit: only the key was undone
    expect(h.labels.undo).toBe('Set step');
  });
});

describe('drag cancel registry', () => {
  it('cancelDrags asks every registered widget; unregistering removes it', () => {
    const asked: string[] = [];
    const offA = registerDragCancel(() => (asked.push('a'), false));
    const offB = registerDragCancel(() => (asked.push('b'), true));
    expect(cancelDrags()).toBe(true);
    expect(asked).toEqual(['a', 'b']);
    offB();
    offB(); // idempotent
    expect(cancelDrags()).toBe(false);
    offA();
    expect(cancelDrags()).toBe(false);
    expect(asked).toEqual(['a', 'b', 'a']);
  });

  it('a cancelled fader drag leaves no entry and undoes nothing older', () => {
    const sink = { send: () => true };
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    p.history = h;
    setTempo(p, sink, 128); // the older entry a stray undo would take back
    const fader = () => p.mixer.channels[d.id].params[0];
    const v0 = fader();
    // The Fader's drag: values while moving; its cancel puts the old one back (Escape's path).
    let dragging = false;
    const off = registerDragCancel(() => {
      if (!dragging) return false;
      dragging = false;
      setMix(p, sink, d.id, 'fader', v0);
      return true;
    });
    const queue: (() => void)[] = [];
    const g = createGestures({ history: () => h, loading: () => false, later: (fn) => void queue.push(fn) });
    g.press({ pointerId: 1, isPrimary: true });
    dragging = true;
    for (let v = -1; v >= -12; v--) setMix(p, sink, d.id, 'fader', v);
    expect(fader()).toBe(-12);
    expect(g.cancelDrag()).toBe(true); // Cmd+Z mid-drag
    expect(fader()).toBe(v0);
    expect(p.tempo).toBe(128);
    g.release({ pointerId: 1 });
    queue.splice(0).forEach((fn) => fn());
    off();
    expect(h.labels).toEqual({ undo: 'Tempo', redo: null }); // no "Set Volume" entry
    expect(h.undo()).toBe(true); // the next Cmd+Z (released) is the normal undo
    expect(p.tempo).not.toBe(128);
  });
});

// Guard: every component with a pointer drag lets undo/redo cancel it.
describe('drag widgets register a drag cancel', () => {
  const UI = join(__dirname, '..', 'ui');
  const svelte = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const f = join(dir, n);
      return statSync(f).isDirectory() ? svelte(f) : n.endsWith('.svelte') ? [f] : [];
    });
  it('every .svelte with setPointerCapture calls registerDragCancel', () => {
    const files = svelte(UI).filter((f) => readFileSync(f, 'utf8').includes('setPointerCapture'));
    expect(files.length).toBeGreaterThan(5);
    const missing = files.filter((f) => !readFileSync(f, 'utf8').includes('registerDragCancel(')).map((f) => f.slice(UI.length + 1));
    expect(missing).toEqual([]);
  });
});
