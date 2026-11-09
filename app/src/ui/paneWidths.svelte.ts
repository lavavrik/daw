// Resizable pane widths: the library sidebar (App's left column) and the
// song timeline's track header column (Timeline's --header-w). A UI
// preference kept in localStorage (like the note names or the octave), never
// in the project: no undo entry, the project is not dirty.
//
// Each pane has a default, a min and a max (PANES). `paneWidths` is a $state,
// so the grid that reads it follows a drag live; setPaneWidth clamps and
// rounds, and saves only when asked (the end of a drag, a key press, a
// double-click reset), so a drag does not write storage on every move.
// The grab strip itself is ui/Splitter.svelte.

export type PaneId = 'library' | 'trackHeaders';

export interface PaneDef { def: number; min: number; max: number }

export const PANES: Record<PaneId, PaneDef> = {
  /** The old fixed 220 px; under 180 the search field and tabs crowd. */
  library: { def: 220, min: 180, max: 480 },
  /** The old tlMath.HEADER_W (176); under 150 the name, slider and M/S/A crowd. */
  trackHeaders: { def: 176, min: 150, max: 360 },
};

const KEY = (id: PaneId) => `daw.paneWidth.${id}`;

/** See ui/noteNames.svelte.ts: node's own localStorage getter warns on any touch. */
function storage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  return Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value;
}

/** `w` rounded to a whole px and kept inside the pane's min..max (NaN: the default). */
export function clampPaneWidth(id: PaneId, w: number): number {
  const d = PANES[id];
  if (!Number.isFinite(w)) return d.def;
  return Math.min(d.max, Math.max(d.min, Math.round(w)));
}

function load(id: PaneId): number {
  try {
    const raw = storage()?.getItem(KEY(id));
    return raw == null ? PANES[id].def : clampPaneWidth(id, Number(raw));
  } catch {
    return PANES[id].def; // storage blocked: the default
  }
}

export const paneWidths = $state<Record<PaneId, number>>({
  library: load('library'),
  trackHeaders: load('trackHeaders'),
});

/** Set a pane's width (clamped); `save` also remembers it for the next start. */
export function setPaneWidth(id: PaneId, w: number, save = true) {
  paneWidths[id] = clampPaneWidth(id, w);
  if (!save) return;
  try {
    storage()?.setItem(KEY(id), String(paneWidths[id]));
  } catch {
    /* not persisted; still applies for this session */
  }
}
