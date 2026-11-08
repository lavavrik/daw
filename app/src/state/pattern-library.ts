// The project's pattern library (plan 21 Task 4; spec 2026-11-15-redesign-
// round-2 §5; docs/architecture/sequencer.md "Pattern library").
//
// A library entry is a COPY of a pattern, by value: a drum pattern's step
// count, swing and rows (each row's name, the file name of its sample, and
// its MAX_STEPS velocities), or a synth pattern's bars and notes. It is not
// tied to the track it came from, so it survives that track's removal and
// can be loaded into any track of its kind.
//
//   save   (savePatternToLibrary)  copies a pattern under a name;
//   load   (loadPatternFromLibrary) makes a NEW pattern in a track from an
//          entry and selects it: it never overwrites anything;
//   rename / delete an entry.
//
// Each is ONE undo entry (edit(); the actions a load is built from just run
// inside it). Names: an entry's name is unique in the library ("Groove",
// "Groove 2", …: saving a duplicate is allowed, it is just numbered), and a
// loaded pattern takes a name unique in its track (pattern-actions freeName).
//
// DRUM ROW MAPPING (mapLibraryRows). An entry's rows rarely line up with the
// target track's: another kit, rows deleted, reordered or renamed. Each
// entry row that has steps goes to
//   1. the first free target row whose sample has the same FILE NAME, else
//   2. the target row with the same INDEX, if that row is still free, else
//   3. nowhere: its steps are dropped, and the load reports how many rows
//      were ("2 rows not in this kit", the UI flashes it).
// An entry row with no steps is placed only by name (pass 1: it claims its
// own sample's row, so it never takes an index another row needs). Row names
// are not matched: a row is named after its sample's kit slot ("Kick") and
// may be renamed freely; the sample is what sounds.
//
// The library's saved form is ProjectJson.patternLibrary (schema 5;
// libraryJson / libraryState convert). Library edits send no engine
// command, so they mark the project edited themselves (markEdited); a load
// sends the ordinary pattern commands.
import { MAX_PATTERNS, MAX_NOTES, Op } from '../audio/protocol';
import type { LibraryPatternJson } from '../project/schema';
import { setStepCount, setSwing } from './actions';
import type { CommandSink } from './actions';
import { edit, markEdited } from './edits';
import { freeName, newPattern, patternOf, renamePattern, sendNote, setPatternBars } from './pattern-actions';
import { MAX_STEPS, currentPattern, isPatternTrack } from './project.svelte';
import type { DrumPattern, DrumTrack, LibraryPattern, NotePatternState, PatternTrack, Project, SynthTrack } from './project.svelte';

// ---- saved form ---------------------------------------------------------------

/** An entry as saved (no UI id; fresh arrays, so a snapshot shares nothing with the live state). */
export function libraryJson(e: LibraryPattern): LibraryPatternJson {
  if (e.kind === 'drum') {
    return {
      kind: 'drum', name: e.name, stepCount: e.stepCount, swing: e.swing,
      rows: e.rows.map((r) => (r.sampleName === undefined
        ? { name: r.name, steps: [...r.steps] }
        : { name: r.name, sampleName: r.sampleName, steps: [...r.steps] })),
    };
  }
  return { kind: 'synth', name: e.name, bars: e.bars, notes: e.notes.map((n) => ({ pitch: n.pitch, vel: n.vel, start: n.start, len: n.len })) };
}

/**
 * The live entries of a validated list. An entry equal to one of `reuse`
 * (the live library an undo replaces) keeps that one's id, so a list
 * showing it keeps its focus and row; the rest get fresh ids.
 */
export function libraryState(list: LibraryPatternJson[], reuse: LibraryPattern[] = []): LibraryPattern[] {
  const old = reuse.map((e) => ({ id: e.id, key: JSON.stringify(libraryJson(e)) }));
  return list.map((j) => {
    const key = JSON.stringify(j);
    const hit = old.findIndex((o) => o.key === key);
    const id = hit >= 0 ? old.splice(hit, 1)[0].id : crypto.randomUUID();
    const copy = JSON.parse(key) as LibraryPatternJson; // nothing shared with the snapshot
    return { id, ...copy };
  });
}

// ---- names --------------------------------------------------------------------

/** "base", then "base 2", "base 3", …: the first name no other entry (but `except`) has. */
export function freeLibraryName(lib: LibraryPattern[], base: string, except?: string): string {
  const names = new Set(lib.filter((e) => e.id !== except).map((e) => e.name));
  let n = 1;
  const name = () => (n === 1 ? base : `${base} ${n}`);
  while (names.has(name())) n++;
  return name();
}

/** Longest entry name (the name fields' maxlength; room for a " 2"). */
export const LIBRARY_NAME_MAX = 60;

/** What Save proposes: "<track> · <pattern>". */
export const defaultLibraryName = (t: PatternTrack, patternName: string) => `${t.name} · ${patternName}`;

/** The hint after a load that dropped `n` drum rows (n > 0). */
export const droppedRowsText = (n: number) => `${n} row${n === 1 ? '' : 's'} not in this kit`;

/** "drum pattern" / "synth pattern": what an entry of the other kind says. */
export const kindText = (kind: 'drum' | 'synth') => `${kind} pattern`;

// ---- drum row mapping ---------------------------------------------------------

/**
 * Where each of `rows` (an entry's) lands in a track whose rows have the
 * sample file names `target` (null: no sample): a target row index, or
 * null (dropped). `dropped`: how many rows WITH steps found no place. See
 * DRUM ROW MAPPING above. Pure.
 */
export function mapLibraryRows(
  rows: { sampleName?: string; steps: number[] }[], target: (string | null)[],
): { to: (number | null)[]; dropped: number } {
  const to: (number | null)[] = rows.map(() => null);
  const taken = new Set<number>();
  rows.forEach((r, i) => {
    if (r.sampleName === undefined) return;
    const j = target.findIndex((name, k) => name === r.sampleName && !taken.has(k));
    if (j >= 0) {
      to[i] = j;
      taken.add(j);
    }
  });
  let dropped = 0;
  rows.forEach((r, i) => {
    if (to[i] !== null || !r.steps.some((v) => v > 0)) return;
    if (i < target.length && !taken.has(i)) {
      to[i] = i;
      taken.add(i);
    } else dropped++;
  });
  return { to, dropped };
}

/** The sample file name of each row of `t` (null: none, or a sample the session has no file for). */
const rowSampleNames = (p: Project, t: DrumTrack) =>
  t.rows.map((r) => (r.sampleId === null ? null : (p.sampleFiles.get(r.sampleId)?.name ?? null)));

// ---- actions ------------------------------------------------------------------

/**
 * Saves a copy of pattern `patternId` of track `trackId` as a new library
 * entry named `name` (trimmed; numbered when taken). Null (nothing changed)
 * for an empty name, an unknown track or pattern.
 */
export function savePatternToLibrary(p: Project, trackId: string, patternId: string, name: string): LibraryPattern | null {
  return edit(p, 'Save pattern to library', () => {
    const t = p.tracks.find((x) => x.id === trackId);
    const pat = t && isPatternTrack(t) ? patternOf(t, patternId) : null;
    const base = name.trim().slice(0, LIBRARY_NAME_MAX);
    if (!t || !pat || !base) return null;
    const id = crypto.randomUUID();
    const entryName = freeLibraryName(p.patternLibrary, base);
    if (t.kind === 'drum') {
      const d = pat as DrumPattern;
      const names = rowSampleNames(p, t);
      p.patternLibrary.push({
        id, name: entryName, kind: 'drum', stepCount: d.stepCount, swing: d.swing,
        rows: t.rows.map((r, i) => ({
          name: r.name,
          ...(names[i] !== null ? { sampleName: names[i]! } : {}),
          steps: [...d.steps[i]],
        })),
      });
    } else {
      const s = pat as NotePatternState;
      p.patternLibrary.push({
        id, name: entryName, kind: 'synth', bars: s.bars,
        notes: [...s.notes].sort((a, b) => a.idx - b.idx).map((n) => ({ pitch: n.pitch, vel: n.vel, start: n.start, len: n.len })),
      });
    }
    markEdited(p); // no engine command
    return p.patternLibrary[p.patternLibrary.length - 1];
  });
}

/** Why entry `e` can't be loaded into `t` now (null: it can). */
export function loadBlocked(t: PatternTrack | null, e: LibraryPattern): string | null {
  if (!t) return 'Select a drum or synth track';
  if (t.kind !== e.kind) return `A ${kindText(e.kind)}: select a ${e.kind} track`;
  if (t.patterns.length >= MAX_PATTERNS) return `At most ${MAX_PATTERNS} patterns per track`;
  return null;
}

/**
 * Loads entry `entryId` into track `trackId` as a NEW pattern, named after
 * the entry (unique in the track), and selects it. Drum rows map as in
 * DRUM ROW MAPPING; `dropped` is how many rows with steps found no place.
 * Synth notes are copied as they are (also ones past the pattern's end:
 * kept, silent, as a copy keeps them). Null (nothing changed) for an
 * unknown track or entry, another kind, or a full track.
 */
export function loadPatternFromLibrary(
  p: Project, sink: CommandSink, trackId: string, entryId: string,
): { pattern: DrumPattern | NotePatternState; dropped: number } | null {
  return edit(p, 'Load library pattern', () => {
    const t = p.tracks.find((x) => x.id === trackId);
    const e = p.patternLibrary.find((x) => x.id === entryId);
    if (!t || !isPatternTrack(t) || !e || loadBlocked(t, e)) return null;
    const name = freeName(t, e.name, false); // before newPattern adds its "Pattern N"
    if (!newPattern(p, sink, t.id)) return null; // cannot happen after loadBlocked
    const pat = currentPattern(t);
    renamePattern(p, sink, t.id, pat.id, name);
    if (t.kind === 'drum' && e.kind === 'drum') return { pattern: pat, dropped: fillDrum(p, sink, t, e) };
    if (t.kind === 'synth' && e.kind === 'synth') fillSynth(p, sink, t, e);
    return { pattern: pat, dropped: 0 };
  });
}

/** The fresh current pattern of `t` becomes entry `e`'s steps; returns the dropped row count. */
function fillDrum(p: Project, sink: CommandSink, t: DrumTrack, e: Extract<LibraryPattern, { kind: 'drum' }>): number {
  setStepCount(p, sink, t.id, e.stepCount);
  setSwing(p, sink, t.id, e.swing);
  const pat = currentPattern(t);
  const { to, dropped } = mapLibraryRows(e.rows, rowSampleNames(p, t));
  e.rows.forEach((r, i) => {
    const row = to[i];
    if (row === null) return;
    for (let s = 0; s < MAX_STEPS; s++) {
      const v = r.steps[s];
      if (!(v > 0)) continue;
      // The pattern is fresh (all 0) and current: write the step as setStep would.
      pat.steps[row][s] = v;
      sink.send(Op.SET_STEP, t.slot, row, s, v);
    }
  });
  return dropped;
}

/** The fresh current pattern of `t` becomes entry `e`'s length and notes (engine idx 0..n-1). */
function fillSynth(p: Project, sink: CommandSink, t: SynthTrack, e: Extract<LibraryPattern, { kind: 'synth' }>) {
  setPatternBars(p, sink, t.id, e.bars);
  const pat = currentPattern(t);
  pat.notes = e.notes.slice(0, MAX_NOTES).map((n, idx) => ({ id: crypto.randomUUID(), idx, ...n }));
  for (const n of pat.notes) sendNote(sink, t, n);
}

/** Renames entry `entryId` (trimmed; numbered when another entry has the name). False for an empty name or an unknown entry. */
export function renameLibraryPattern(p: Project, entryId: string, name: string): boolean {
  return edit(p, 'Rename library pattern', () => {
    const e = p.patternLibrary.find((x) => x.id === entryId);
    const base = name.trim().slice(0, LIBRARY_NAME_MAX);
    if (!e || !base) return false;
    const next = freeLibraryName(p.patternLibrary, base, e.id);
    if (next === e.name) return true;
    e.name = next;
    markEdited(p);
    return true;
  });
}

/** Removes entry `entryId` from the library (patterns loaded from it stay). False for an unknown entry. */
export function deleteLibraryPattern(p: Project, entryId: string): boolean {
  return edit(p, 'Delete library pattern', () => {
    if (!p.patternLibrary.some((x) => x.id === entryId)) return false;
    p.patternLibrary = p.patternLibrary.filter((x) => x.id !== entryId);
    markEdited(p);
    return true;
  });
}
