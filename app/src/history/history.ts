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
//     Such a merge takes no snapshot at all: the entry's "after" goes stale
//     and is taken lazily by settle() (below), so a recorded note costs O(1).
//   - coalesceTask (App): one-shot edits made in the same task merge too, so
//     a key press or paste that runs several actions is one entry.
//   - holdOpen(key) / release() (plan 9): while the newest entry has the held
//     key (and nothing was undone since), EVERY edit merges into it, lazily
//     (a recording pass absorbs the edits made during it: the recorder holds
//     "rec:<pass>" from the pass's first note until the pass ends). begin()
//     and commit() then neither open nor close an entry (commit still
//     settles); a drag still running when the hold is released continues as
//     a gesture of its own. A gesture already open when the hold starts gets
//     the key, so its entry becomes the held one. `undoAbsorbed` counts the
//     absorbed edits (a gesture or a same-task group counts once).
// An entry whose before and after only differ in the track selection is
// dropped (selecting is not an edit; projectFingerprint ignores it too).
// A new entry clears the redo stack; at most `cap` entries are kept.
//
// Cost (plan 8):
//   - Snapshots share structure: each one is passed through shareSnapshot
//     against the previous one, so tracks / strips / patterns that did not
//     change are the same (frozen in dev/test) objects across every entry.
//     "Did anything change" compares snapshots (sameProject: identical
//     subtrees are skipped), so no fingerprint strings are built or kept.
//   - Lazy "after": a keyed merge only marks the newest entry stale.
//     settle() takes its "after" when it is needed: before the next entry's
//     "before" (or any transact that is not such a merge), before an
//     undo/redo, at a gesture's commit, and before a change that is saved
//     but not an edit (selectPattern, selectTrack and Save As's rename call
//     settle(); a new such change must too), so the "after" is exactly the
//     state at the pass's last note, as when it was taken eagerly.
//
// Starting-point changes (plan 8 Task 4): the default kit's samples land in
// a fresh session asynchronously, maybe after the user already edited. They
// are not edits (no entry; state/edits.ts Project.baselining), and an undo
// must not take them away: rebase(fn) patches every stored snapshot (both
// stacks, an open gesture's "before") with the same change, so each entry
// still differs only by its own edit.
import type { ProjectJson } from '../project/schema';
import { banners } from '../state/banners.svelte';
import { jsonEqual, sameProject, shareSnapshot } from '../project/serialize';

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
  /** Deep-freeze snapshots (default: dev and test builds), so a write to a shared one throws. */
  freeze?: boolean;
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
  /**
   * Take the newest entry's lazy "after" now, if it is stale. Call it right
   * before a change of saved state that is not an edit (a pattern or track
   * switch), so that change is not folded into the entry. Cheap otherwise.
   */
  settle(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Labels of the entry undo / redo would apply ("Move notes"), or null. */
  readonly labels: { undo: string | null; redo: string | null };
  /** The coalesce key of the entry undo would apply ("rec:3": a recording pass), or null. */
  readonly undoKey: string | null;
  /**
   * Hold the newest entry with coalesce key `key` open: from now on every
   * edit (one-shots, gestures) merges into it while it is the newest entry
   * and nothing was undone since. One hold at a time (a new key replaces
   * the old one). The recorder holds "rec:<pass>" from the pass's first note.
   */
  holdOpen(key: string): void;
  /** End the hold (the pass ended). Harmless when nothing is held. */
  release(): void;
  /** Edits absorbed by the entry undo would apply while it was held (see holdOpen); 0 if none. */
  readonly undoAbsorbed: number;
  /**
   * A starting-point change was just applied to the live project outside
   * the history: map every stored snapshot through `fn` (pure; returns its
   * argument when the change does not apply to it), keeping them shared and
   * frozen. See the header.
   */
  rebase(fn: (snap: ProjectJson) => ProjectJson): void;
  /** True while undo/redo applies a snapshot (actions then just run). */
  readonly applying: boolean;
}

/** debugStacks' result: per stack (oldest first), each entry's id and merge count. */
export type DebugStacks = { undo: [id: number, merges: number][]; redo: [id: number, merges: number][] };

/** Each history's stack view, for debugStacks (not part of History). */
const stackViews = new WeakMap<History, () => DebugStacks>();

/**
 * Test-only view of `h`'s stacks (oldest first): each entry's id (unique for
 * this history) and how many edits merged into it. No snapshots: the
 * property test keeps its own expected states per entry. Kept off the
 * History interface, so app code cannot come to depend on it.
 */
export function debugStacks(h: History): DebugStacks {
  const view = stackViews.get(h);
  if (!view) throw new Error('debugStacks: not a createHistory history');
  return view();
}

interface Entry {
  label: string;
  /** Immutable, structurally shared snapshots. */
  before: ProjectJson;
  after: ProjectJson;
  coalesce?: string;
  /** Keyed merges since `after` was taken (only ever the newest entry): settle() retakes it. */
  stale?: boolean;
  /** debugStacks (test-only): identity and merge count. */
  id: number;
  merges: number;
  /** Other edits merged in while it was held (holdOpen): a gesture or a same-task group counts once. */
  absorbed: number;
}

interface Open {
  label: string | null;
  /** Taken at the first transact inside (null: nothing edited yet). */
  before: ProjectJson | null;
  coalesce?: string;
  /** A one-shot that will merge into this (newest) entry: needs no before-snapshot. */
  into?: Entry;
  /** Opened by begin() (a pointer gesture), not by a transact. */
  gesture?: boolean;
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
  const freeze = o.freeze ?? import.meta.env.DEV;
  /** The newest snapshot taken or applied: the next one shares with it. */
  let lastSnap: ProjectJson | null = null;
  let nextId = 1;
  /** holdOpen's key (null: no hold). */
  let hold: string | null = null;
  /** begin() was skipped because of the hold, and its commit() has not come yet. */
  let heldGesture = false;
  /** That gesture already counted as one absorbed edit. */
  let heldGestureCounted = false;
  /** A same-task one-shot already counted as one absorbed edit (coalesceTask). */
  let absorbedTask = false;

  /** A snapshot of the live project, sharing every unchanged subtree with the previous one. */
  function snap(): ProjectJson {
    lastSnap = shareSnapshot(lastSnap, o.snapshot(), freeze);
    return lastSnap;
  }

  /**
   * Take the newest entry's stale "after" (see the header); drop the entry if
   * the pass changed nothing. Returns the snapshot it took (the live project
   * now) and whether the entry was dropped; null when nothing was stale.
   */
  function settle(): { now: ProjectJson; dropped: boolean } | null {
    const top = undo[undo.length - 1];
    if (!top?.stale || applying) return null;
    top.stale = false;
    const now = snap();
    if (sameProject(now, top.before)) {
      undo.pop(); // merged back to where it started: nothing to undo
      if (last === top) last = null;
      changed();
      return { now, dropped: true };
    }
    top.after = now;
    return { now, dropped: false };
  }

  const takeBefore = (g: Open) => {
    if (g.before) return;
    settle(); // the newest entry's "after" is this state, before this edit runs
    g.before = snap();
  };

  /** The held entry: the newest one, with the held key, nothing undone since. */
  function heldTarget(): Entry | undefined {
    const top = undo[undo.length - 1];
    return hold !== null && top && top === last && top.coalesce === hold ? top : undefined;
  }

  /** The newest entry, if an edit with coalesce key `key` made now would merge into it. */
  function mergeTarget(key: string | undefined): Entry | undefined {
    const top = undo[undo.length - 1];
    if (heldTarget()) return top;
    return top && top === last && ((key !== undefined && top.coalesce === key) || (o.coalesceTask && taskOpen)) ? top : undefined;
  }

  /** An edit other than the held entry's own (a pass's note) merged into it: count it. */
  function absorb(top: Entry) {
    if (heldGesture) {
      if (!heldGestureCounted) top.absorbed++;
      heldGestureCounted = true;
    } else if (!absorbedTask) {
      top.absorbed++;
      if (o.coalesceTask) {
        absorbedTask = true;
        queueMicrotask(() => (absorbedTask = false));
      }
    }
  }

  function push(g: Open) {
    if (!g.before && !g.into) return;
    const top = undo[undo.length - 1];
    const merge = g.into ? g.into === top && top === last : mergeTarget(g.coalesce) !== undefined;
    if (merge) top.merges++;
    const held = merge && heldTarget() === top;
    if (held && g.coalesce !== top.coalesce) absorb(top);
    if (merge && ((g.coalesce !== undefined && top.coalesce === g.coalesce) || held)) {
      top.stale = true; // a recorded note, or an edit the held pass absorbs: no snapshot now (settle() takes it)
    } else if (merge) {
      const after = snap();
      top.stale = false;
      if (sameProject(after, top.before)) {
        undo.pop(); // merged back to where it started: nothing to undo
        last = null;
      } else top.after = after;
    } else {
      if (!g.before) return;
      const after = snap();
      if (sameProject(g.before, after)) return; // nothing (but maybe the selection) changed
      // Share the snapshot with the previous entry when nothing happened between them.
      const before = top && jsonEqual(top.after, g.before) ? top.after : g.before;
      const e: Entry = { label: g.label ?? 'Edit', before, after, coalesce: g.coalesce, id: nextId++, merges: 0, absorbed: 0 };
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
    // A recording pass's "after" is the state now. If the pass changed
    // nothing it goes, and that is this undo: the ↶ named it, so the entry
    // before it is not undone as well.
    const settled = settle();
    if (settled?.dropped && from === undo) return true;
    const e = from.pop();
    if (!e) return false;
    applying = true;
    try {
      // settle's snapshot is still the live project (nothing ran since).
      o.apply(settled?.now ?? snap(), target(e));
      lastSnap = target(e); // the live project now (the next snapshot shares with it)
    } catch (err) {
      // The project may be half-applied, so no entry can be trusted: drop
      // them all (the popped one included) and say so.
      console.error('history apply failed', err);
      applying = false;
      undo.length = 0;
      redo.length = 0;
      open = null;
      last = null;
      lastSnap = null;
      changed();
      banners.error = 'Undo failed \u2014 history cleared';
      return false;
    } finally {
      applying = false;
    }
    to.push(e);
    last = null;
    changed();
    return true;
  }

  const h: History = {
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
      const g: Open = { label, before: null, coalesce: opts?.coalesce, into: mergeTarget(opts?.coalesce) };
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
      if (heldTarget()) {
        // Held: the gesture's edits merge one by one into the held entry.
        heldGesture = true;
        heldGestureCounted = false;
        return;
      }
      heldGesture = false;
      open = { label: label ?? null, before: null, gesture: true };
    },
    commit() {
      if (depth > 0) return;
      heldGesture = false;
      close();
      settle();
    },
    undo: () => move(undo, redo, (e) => e.before),
    redo: () => move(redo, undo, (e) => e.after),
    clear() {
      undo.length = 0;
      redo.length = 0;
      open = null;
      last = null;
      lastSnap = null;
      hold = null;
      heldGesture = false;
      changed();
    },
    holdOpen(key) {
      // A gesture open since before the pass's first note (which landed in
      // it): its entry becomes the held one.
      if (open?.gesture && !open.into) open.coalesce = key;
      if (hold === key) return; // the recorder calls it at every note
      hold = key;
      changed();
    },
    release() {
      if (hold === null) return;
      hold = null;
      if (heldGesture && depth === 0 && !open) {
        // A drag still running: the rest of it is a gesture of its own.
        heldGesture = false;
        open = { label: null, before: null, gesture: true };
      }
      changed();
    },
    settle: () => {
      if (depth === 0) settle();
    },
    rebase(fn) {
      // One result per snapshot object: entries that shared one still do.
      const done = new Map<ProjectJson, ProjectJson>();
      const map = (s: ProjectJson): ProjectJson => {
        let r = done.get(s);
        if (!r) {
          const next = fn(s);
          r = next === s ? s : shareSnapshot(s, next, freeze);
          done.set(s, r);
        }
        return r;
      };
      for (const e of [...undo, ...redo]) {
        e.before = map(e.before);
        e.after = map(e.after); // a stale "after" is retaken from the live project anyway
      }
      if (open?.before) open.before = map(open.before);
      if (lastSnap) lastSnap = map(lastSnap);
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
    get undoAbsorbed() {
      return undo[undo.length - 1]?.absorbed ?? 0;
    },
    get applying() {
      return applying;
    },
  };
  stackViews.set(h, () => ({
    undo: undo.map((e) => [e.id, e.merges]),
    redo: redo.map((e) => [e.id, e.merges]),
  }));
  return h;
}
