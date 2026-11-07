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
  /** True while undo/redo applies a snapshot (actions then just run). */
  readonly applying: boolean;
  /**
   * Test-only view of the stacks (oldest first): each entry's id (unique for
   * this history) and how many edits merged into it. No snapshots: the
   * property test keeps its own expected states per entry.
   */
  debugStacks(): { undo: [id: number, merges: number][]; redo: [id: number, merges: number][] };
}

interface Entry {
  label: string;
  /** Immutable, structurally shared snapshots. */
  before: ProjectJson;
  after: ProjectJson;
  coalesce?: string;
  /** Keyed merges since `after` was taken (only ever the newest entry): settle() retakes it. */
  stale?: boolean;
  /** debugStacks: identity and merge count. */
  id: number;
  merges: number;
}

interface Open {
  label: string | null;
  /** Taken at the first transact inside (null: nothing edited yet). */
  before: ProjectJson | null;
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
  const freeze = o.freeze ?? import.meta.env.DEV;
  /** The newest snapshot taken or applied: the next one shares with it. */
  let lastSnap: ProjectJson | null = null;
  let nextId = 1;

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

  /** The newest entry, if an edit with coalesce key `key` made now would merge into it. */
  function mergeTarget(key: string | undefined): Entry | undefined {
    const top = undo[undo.length - 1];
    return top && top === last && ((key !== undefined && top.coalesce === key) || (o.coalesceTask && taskOpen)) ? top : undefined;
  }

  function push(g: Open) {
    if (!g.before && !g.into) return;
    const top = undo[undo.length - 1];
    const merge = g.into ? g.into === top && top === last : mergeTarget(g.coalesce) !== undefined;
    if (merge) top.merges++;
    if (merge && g.coalesce !== undefined && top.coalesce === g.coalesce) {
      top.stale = true; // a recorded note: no snapshot now (settle() takes it)
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
      const e: Entry = { label: g.label ?? 'Edit', before, after, coalesce: g.coalesce, id: nextId++, merges: 0 };
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
      open = { label: label ?? null, before: null };
    },
    commit() {
      if (depth > 0) return;
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
      changed();
    },
    settle: () => {
      if (depth === 0) settle();
    },
    debugStacks: () => ({
      undo: undo.map((e) => [e.id, e.merges]),
      redo: redo.map((e) => [e.id, e.merges]),
    }),
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
