import { describe, expect, it } from 'vitest';
import { createGestures } from './gestures';

/** A fake history logging begin/commit, and a manual one-task-later queue. */
function setup() {
  const log: string[] = [];
  const queue: (() => void)[] = [];
  let loading = false;
  const g = createGestures({
    history: () => ({ begin: () => log.push('begin'), commit: () => log.push('commit') }),
    loading: () => loading,
    later: (fn) => void queue.push(fn),
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
});
