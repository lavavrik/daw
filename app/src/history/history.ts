// Undo/redo on project snapshots (docs/architecture/history.md).
//
// An entry is { label, before, after }: two serialized projects (serialize,
// minus sample bytes: those are immutable and keyed by id in p.sampleFiles).
// Undo restores `before` and redo `after` through `apply(live, target)`
// (App: diffApply, which sends only the commands the difference needs).
//
// How edits become entries:
//   - transact(label, fn): every user-level action runs inside one (the
//     action wrappers in state/*-actions.ts, via state/edits.ts `edit`).
//     The outermost one snapshots before and after; nested ones just run.
//   - begin()/commit() bracket a gesture (App: every pointer gesture, so a
//     knob/fader/note/clip drag is one entry). Inside it, the first transact
//     takes the "before" snapshot (lazily: a click that edits nothing costs
//     nothing) and names the entry, unless begin(label) named it.
//   - opts.coalesce: consecutive transacts with the same key merge into one
//     entry (a recording pass: one entry however many notes it writes),
//     while that entry is the newest one and nothing was undone since.
//   - coalesceTask (App): one-shot edits made in the same task merge too, so
//     a key press or paste that runs several actions is one entry.
// An entry whose before and after only differ in the track selection is
// dropped (selecting is not an edit; projectFingerprint ignores it too).
// A new entry clears the redo stack; at most `cap` entries are kept.
import type { ProjectJson } from '../project/schema';
import { fingerprintOf } from '../project/serialize';

export interface HistoryOptions {
  snapshot: () => ProjectJson;
  /** Make the live project (`from`, a fresh snapshot) match `to`. */
  apply: (from: ProjectJson, to: ProjectJson) => void;
  /** Most entries kept (oldest dropped first). */
  cap?: number;
  /** Undo/redo are refused while this is false (App: a load replaces the session). */
  canApply?: () => boolean;
  /**
   * Right before an undo/redo (App: the recorder closes held notes, which
   * then belong to the pass being undone, not to a state that vanishes).
   */
  beforeApply?: () => void;
  /** After every change of the undo/redo stacks (the top bar's buttons). */
  onChange?: () => void;
  /** Merge one-shot entries made in the same task (see above). */
  coalesceTask?: boolean;
}

export interface History {
  transact<T>(label: string, fn: () => T, opts?: { coalesce?: string }): T;
  /** Start a gesture (pointerdown). A gesture still open is committed first. */
  begin(label?: string): void;
  /** End the gesture (pointerup): one entry if anything changed. */
  commit(): void;
  undo(): boolean;
  redo(): boolean;
  /** Forget everything (a project load, New, restore). */
  clear(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Labels of the entry undo / redo would apply ("Move notes"), or null. */
  readonly labels: { undo: string | null; redo: string | null };
  /** The coalesce key of the entry undo would apply ("rec:3": a recording pass), or null. */
  readonly undoKey: string | null;
  /** True while undo/redo applies a snapshot (actions then just run). */
  readonly applying: boolean;
}

interface Entry {
  label: string;
  before: ProjectJson;
  after: ProjectJson;
  /** fingerprintOf(before / after): merge checks and snapshot sharing. */
  beforeFp: string;
  afterFp: string;
  coalesce?: string;
}

interface Open {
  label: string | null;
  /** Taken at the first transact inside (null: nothing edited yet). */
  before: ProjectJson | null;
  beforeFp: string | null;
  coalesce?: string;
  /** A one-shot that will merge into this (newest) entry: needs no before-snapshot. */
  into?: Entry;
}

export function createHistory(o: HistoryOptions): History {
  const cap = o.cap ?? 200;
  // Emptied in place, never reassigned: move() holds them across a commit.
  const undo: Entry[] = [];
  const redo: Entry[] = [];
  let open: Open | null = null;
  let depth = 0; // transacts running
  let applying = false;
  /** The entry the last push made or merged into; null after undo/redo/clear. */
  let last: Entry | null = null;
  let taskOpen = false;
  const changed = () => o.onChange?.();

  const takeBefore = (g: Open) => {
    if (g.before) return;
    g.before = o.snapshot();
    g.beforeFp = fingerprintOf(g.before);
  };

  /** The newest entry, if an edit with coalesce key `key` made now would merge into it. */
  function mergeTarget(key: string | undefined): Entry | undefined {
    const top = undo[undo.length - 1];
    return top && top === last && ((key !== undefined && top.coalesce === key) || (o.coalesceTask && taskOpen)) ? top : undefined;
  }

  function push(g: Open) {
    if (!g.before && !g.into) return;
    const after = o.snapshot();
    const afterFp = fingerprintOf(after);
    const top = undo[undo.length - 1];
    const merge = g.into ? g.into === top && top === last : mergeTarget(g.coalesce) !== undefined;
    if (merge) {
      if (afterFp === top.beforeFp) {
        undo.pop(); // merged back to where it started: nothing to undo
        last = null;
      } else Object.assign(top, { after, afterFp });
    } else {
      if (!g.before || g.beforeFp === afterFp) return; // nothing (but maybe the selection) changed
      // Share the snapshot with the previous entry when nothing happened between them.
      const before = top && top.afterFp === g.beforeFp && JSON.stringify(top.after.selection) === JSON.stringify(g.before.selection) ? top.after : g.before;
      const e: Entry = { label: g.label ?? 'Edit', before, after, beforeFp: g.beforeFp!, afterFp, coalesce: g.coalesce };
      undo.push(e);
      if (undo.length > cap) undo.splice(0, undo.length - cap);
      last = e;
    }
    redo.length = 0;
    if (o.coalesceTask && !taskOpen) {
      taskOpen = true;
      queueMicrotask(() => (taskOpen = false));
    }
    changed();
  }

  function close() {
    const g = open;
    open = null;
    if (g) push(g);
  }

  function move(from: Entry[], to: Entry[], target: (e: Entry) => ProjectJson): boolean {
    if (applying || depth > 0 || (o.canApply && !o.canApply())) return false;
    if (from.length === 0 && !open?.before) return false; // nothing to apply (and no gesture edit to commit)
    o.beforeApply?.();
    close(); // an open gesture is an edit that happened first
    const e = from.pop();
    if (!e) return false;
    applying = true;
    try {
      o.apply(o.snapshot(), target(e));
    } finally {
      applying = false;
    }
    to.push(e);
    last = null;
    changed();
    return true;
  }

  return {
    transact(label, fn, opts) {
      if (applying) return fn();
      if (open) {
        if (!open.into) takeBefore(open);
        if (open.label === null) open.label = label;
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      const g: Open = { label, before: null, beforeFp: null, coalesce: opts?.coalesce, into: mergeTarget(opts?.coalesce) };
      if (!g.into) takeBefore(g); // a merge keeps the entry's own "before"
      open = g;
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0 && open === g) close();
      }
    },
    begin(label) {
      if (applying || depth > 0) return;
      close();
      open = { label: label ?? null, before: null, beforeFp: null };
    },
    commit() {
      if (depth === 0) close();
    },
    undo: () => move(undo, redo, (e) => e.before),
    redo: () => move(redo, undo, (e) => e.after),
    clear() {
      undo.length = 0;
      redo.length = 0;
      open = null;
      last = null;
      changed();
    },
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },
    get labels() {
      return { undo: undo[undo.length - 1]?.label ?? null, redo: redo[redo.length - 1]?.label ?? null };
    },
    get undoKey() {
      return undo[undo.length - 1]?.coalesce ?? null;
    },
    get applying() {
      return applying;
    },
  };
}
