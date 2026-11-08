// Acid tab: a step view of a synth pattern's notes (plan 17, spec addendum §2).
//
// There is no stored step format. The steps are read from
// `NotePatternState.notes` and every edit is written back as a NoteDiff, so
// the piano roll, recording, clips and export see ordinary notes. Pure module:
// no Svelte state, no project access (Task 3 applies the diffs, Task 4 renders).
//
// MAPPING (one step = STEP_TICKS = 240 ticks, 16 per bar, at most 64 steps)
//   Pitch     step pitch = base + key + 12·oct (key 0..11, oct −1/0/+1), so the
//             window is base−12 .. base+23. `base` is a MIDI C (default 36).
//   Write     A *run* is a note step plus the tie steps after it; it becomes one
//             note at start = 240·i with velocity 120 (accent) or 80, and
//               len = (1+k)·240 − 120          for a run of 1 note + k ties,
//               len = (next note start − start) + 60   when the run's last step
//                                                       has slide set.
//             A slide is only stored when the step after the run is a note; a
//             slide before a rest or at the pattern end is dropped (the UI
//             disables the toggle there). A tie with no note before it is a rest;
//             a tie carries no pitch or accent (key/oct 0, accent false).
//   Read      A note covers ceil(len/240) steps, capped before the next note's
//             step and at the pattern end; the covered steps after its own are
//             ties. It is a slide (flag on its last covered step) when it runs
//             past the next note's start. vel ≥ 110 reads as an accent (not
//             100: the app's default velocity for QWERTY and drawn notes is
//             100, so every ordinary note would read as one). Notes
//             starting at/after bars·16 steps are ignored: kept, never shown.
//   Unshowable (precedence long > offgrid > chord > poly > range): more than
//             4 bars; a start off the 240 grid; two starts on one step; a note
//             running past the start of the note after next; a pitch outside
//             the window of every candidate base.
//
// REWRITE RULE (planEdit). Reading never edits. An edit compares the old
// reading O with the next steps N (both canonical, same base) run by run:
//   - a run new in N (its note step was a rest/tie in O) is added canonically;
//   - an old note whose step is no longer a note step in N is removed;
//   - a run whose note step is a note in both keeps its note (same id) and is
//     updated field by field, each field rewritten to its canonical value only
//     when its own inputs changed:
//       pitch ← the note step's key/oct;   vel ← its accent;
//       len   ← the run's tie count, the slide on its last step, and (only
//               with that slide) whether the step right after the run is a
//               note.
//     So a run whose steps and following step are unchanged is left exactly as
//     it is, and a piano-roll length (240, 480, a 30-tick slide overlap…)
//     survives edits that don't concern it.
//   - one safety net: a kept length that would now run past the start of the
//     note after next (a long slide overlap, once a note is inserted behind its
//     target) would read as polyphony, so that length is rewritten too.
// Proof sketch that a kept length still reads the same: with a slide, the
// step after the run is a note in both readings, so the next note's start is
// unchanged; without one, the old length was ≤ the run's span (it neither
// ran past a next note nor was capped by one), so adding, moving or removing
// later notes can't change its coverage or make it a slide.
import { STEP_TICKS } from '../audio/protocol';
import type { Note } from './project.svelte';

export type StepKind = 'note' | 'rest' | 'tie';
export interface AcidStep { kind: StepKind; key: number; oct: -1 | 0 | 1; accent: boolean; slide: boolean }
export const REST: AcidStep = Object.freeze({ kind: 'rest', key: 0, oct: 0, accent: false, slide: false });
export type Unshowable = 'offgrid' | 'chord' | 'poly' | 'range' | 'long';
export type StepView =
  | { ok: true; base: number; steps: AcidStep[] }
  | { ok: false; reason: Unshowable };
export interface NoteInit { pitch: number; vel: number; start: number; len: number }
export interface NoteDiff {
  add: NoteInit[];
  update: { id: string; pitch?: number; vel?: number; start?: number; len?: number }[];
  remove: string[];
}

export const DEFAULT_BASE = 36;
/**
 * Lowest / highest base (the tab's −/+ range and every auto-fit or Convert
 * base): the window base−12 .. base+23 stays inside MIDI 0..127.
 */
export const MIN_BASE = 12;
export const MAX_BASE = 96;
/** Longest pattern the tab can show (spec §2.7). */
export const ACID_MAX_BARS = 4;
const STEPS_PER_BAR = 16;
/** A plain (untied, unslid) note lasts half a step. */
const GATE_TICKS = STEP_TICKS / 2;
/** A slid note overlaps the next note's start by this much (triggers legato glide). */
const SLIDE_OVERLAP = 60;
const ACCENT_VEL = 120;
const PLAIN_VEL = 80;
/**
 * A velocity at or above this reads as an accent. Matches the Accent module's
 * default `threshold` (110/127, engine/src/rack/catalog.rs). Above 100, the
 * app's default velocity (QWERTY piano, drawn notes), which must read plain.
 */
const ACCENT_MIN_VEL = 110;

type NoteLike = NoteInit;

export function stepPitch(base: number, s: AcidStep): number {
  return base + s.key + 12 * s.oct;
}

/**
 * The canonical form of a step list, `bars`·16 long (missing steps are rests):
 * a tie with no note before it is a rest, ties carry no key/oct/accent, and a
 * slide survives only on a run's last step when the step after is a note.
 */
export function normalizeSteps(steps: readonly AcidStep[], bars: number): AcidStep[] {
  const n = Math.max(0, bars * STEPS_PER_BAR);
  const out: AcidStep[] = [];
  for (let i = 0; i < n; i++) {
    const s = steps[i] ?? REST;
    if (s.kind === 'note') out.push({ kind: 'note', key: s.key, oct: s.oct, accent: s.accent, slide: s.slide });
    else if (s.kind === 'tie' && i > 0 && out[i - 1].kind !== 'rest') out.push({ ...REST, kind: 'tie', slide: s.slide });
    else out.push(REST);
  }
  for (let i = 0; i < n; i++) {
    if (out[i].slide && out[i + 1]?.kind !== 'note') out[i] = { ...out[i], slide: false };
  }
  return out;
}

/** Index of the run's last step (the run starting at note step `i`). */
function runEnd(steps: readonly AcidStep[], i: number): number {
  let j = i;
  while (steps[j + 1]?.kind === 'tie') j++;
  return j;
}

/** Canonical note for the run starting at note step `i` of canonical `steps`. */
function canonicalNote(steps: readonly AcidStep[], base: number, i: number): NoteInit {
  const s = steps[i];
  const j = runEnd(steps, i);
  const len = steps[j].slide ? (j + 1 - i) * STEP_TICKS + SLIDE_OVERLAP : (j + 1 - i) * STEP_TICKS - GATE_TICKS;
  return { pitch: stepPitch(base, s), vel: s.accent ? ACCENT_VEL : PLAIN_VEL, start: i * STEP_TICKS, len };
}

/**
 * The inputs of a run's canonical length; equal shapes keep a note's length.
 * Whether a note follows the run matters only when the run's last step has a
 * slide (the overlap reaches that note). Without one, a read length is at
 * most the run's span and covers exactly its steps whatever follows, so a
 * held 480-tick note keeps its length when a note is entered right after it.
 */
function lenShape(steps: readonly AcidStep[], i: number): string {
  const j = runEnd(steps, i);
  const slide = steps[j].slide;
  return `${j - i}:${slide}:${slide && steps[j + 1]?.kind === 'note'}`;
}

/** Notes starting before the pattern end, sorted by start. */
function shown<T extends NoteLike>(notes: readonly T[], nSteps: number): T[] {
  return notes.filter((n) => n.start < nSteps * STEP_TICKS).sort((a, b) => a.start - b.start);
}

/** offgrid / chord / poly for sorted shown notes (in that precedence), or null. */
function shapeProblem(sorted: readonly NoteLike[]): Unshowable | null {
  if (sorted.some((n) => n.start % STEP_TICKS !== 0)) return 'offgrid';
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start === sorted[i - 1].start) return 'chord';
  for (let i = 0; i + 2 < sorted.length; i++) {
    if (sorted[i].start + sorted[i].len > sorted[i + 2].start) return 'poly';
  }
  return null;
}

function fits(sorted: readonly NoteLike[], base: number): boolean {
  return sorted.every((n) => n.pitch >= base - 12 && n.pitch <= base + 23);
}

/**
 * Auto-fit bases from the lowest pitch (spec §2.6 "fit the lowest note"),
 * only those in MIN_BASE..MAX_BASE: a pattern that would need another base
 * reads as 'range' (Convert folds it into the window).
 */
function autoBases(sorted: readonly NoteLike[]): number[] {
  if (sorted.length === 0) return [];
  const low = 12 * Math.floor(Math.min(...sorted.map((n) => n.pitch)) / 12);
  return [low + 12, low].filter((b) => b >= MIN_BASE && b <= MAX_BASE);
}

/**
 * Steps for sorted, on-grid, one-per-step notes whose pitches fit `base`
 * (callers guarantee this). Coverage is capped, so overlaps can't show.
 */
function buildSteps(sorted: readonly NoteLike[], nSteps: number, base: number): AcidStep[] {
  const steps: AcidStep[] = Array.from({ length: nSteps }, () => REST);
  sorted.forEach((n, k) => {
    const i = n.start / STEP_TICKS;
    const next = sorted[k + 1];
    const cap = (next ? next.start / STEP_TICKS : nSteps) - i;
    const cover = Math.min(Math.ceil(n.len / STEP_TICKS), cap);
    const p = n.pitch - base;
    const oct = Math.floor(p / 12) as -1 | 0 | 1;
    steps[i] = { kind: 'note', key: p - 12 * oct, oct, accent: n.vel >= ACCENT_MIN_VEL, slide: false };
    for (let t = 1; t < cover; t++) steps[i + t] = { ...REST, kind: 'tie' };
    if (next && n.start + n.len > next.start) steps[i + cover - 1] = { ...steps[i + cover - 1], slide: true };
  });
  return steps;
}

/** Read at exactly `base` (no auto-fit). */
function readAt(notes: readonly Note[], bars: number, base: number): StepView {
  if (bars > ACID_MAX_BARS) return { ok: false, reason: 'long' };
  const nSteps = Math.max(0, bars * STEPS_PER_BAR);
  const sorted = shown(notes, nSteps);
  const problem = shapeProblem(sorted);
  if (problem) return { ok: false, reason: problem };
  if (!fits(sorted, base)) return { ok: false, reason: 'range' };
  return { ok: true, base, steps: buildSteps(sorted, nSteps, base) };
}

/** steps = bars·16. Notes starting at/after the end are ignored (kept, not shown). */
export function readSteps(notes: readonly Note[], bars: number, base: number = DEFAULT_BASE): StepView {
  const first = readAt(notes, bars, base);
  if (first.ok || first.reason !== 'range') return first;
  const sorted = shown(notes, bars * STEPS_PER_BAR);
  const fit = autoBases(sorted).find((b) => fits(sorted, b));
  return fit === undefined ? first : readAt(notes, bars, fit);
}

/**
 * The minimal diff that makes `notes` read as `next` (same base); see the
 * REWRITE RULE above. `next` is normalized first. When `notes` can't be read
 * at `base` (e.g. "Convert to steps"), every shown note is removed and every
 * run added; notes past the end are always kept.
 */
export function planEdit(notes: readonly Note[], bars: number, base: number, next: readonly AcidStep[]): NoteDiff {
  const nSteps = Math.max(0, bars * STEPS_PER_BAR);
  const N = normalizeSteps(next, bars);
  const sorted = shown(notes, nSteps);
  const diff: NoteDiff = { add: [], update: [], remove: [] };
  const old = readAt(notes, bars, base);
  if (!old.ok) {
    diff.remove = sorted.map((n) => n.id);
    N.forEach((s, i) => { if (s.kind === 'note') diff.add.push(canonicalNote(N, base, i)); });
    return diff;
  }
  const O = old.steps;
  const byStep = new Map(sorted.map((n) => [n.start / STEP_TICKS, n]));
  const noteSteps = N.flatMap((s, i) => (s.kind === 'note' ? [i] : []));

  for (const n of sorted) if (N[n.start / STEP_TICKS].kind !== 'note') diff.remove.push(n.id);

  noteSteps.forEach((i, k) => {
    const want = canonicalNote(N, base, i);
    const n = byStep.get(i);
    if (!n) { diff.add.push(want); return; }
    const o = O[i];
    const s = N[i];
    const u: NoteDiff['update'][number] = { id: n.id };
    if (o.key !== s.key || o.oct !== s.oct) u.pitch = want.pitch;
    if (o.accent !== s.accent) u.vel = want.vel;
    // Safety net: a kept length must not reach the note after next (poly).
    const afterNext = noteSteps[k + 2];
    const polyIfKept = afterNext !== undefined && n.start + n.len > afterNext * STEP_TICKS;
    if (lenShape(O, i) !== lenShape(N, i) || polyIfKept) u.len = want.len;
    if (u.pitch === n.pitch) delete u.pitch;
    if (u.vel === n.vel) delete u.vel;
    if (u.len === n.len) delete u.len;
    if (Object.keys(u).length > 1) diff.update.push(u);
  });
  return diff;
}

/**
 * For "Convert to steps" (spec §2.7): starts snap to the nearest step, a chord
 * keeps its highest note, pitches fold into the window by octaves, only the
 * first 64 steps are kept. The base is the one `readSteps` would pick if every
 * pitch fits; otherwise the C (MIN_BASE..MAX_BASE) whose window holds the most
 * pitches, preferring DEFAULT_BASE. Lengths are read as usual (capped, so no poly).
 */
export function convertSteps(notes: readonly Note[], bars: number): { base: number; steps: AcidStep[] } {
  const nSteps = Math.min(bars, ACID_MAX_BARS) * STEPS_PER_BAR;
  const byStep = new Map<number, NoteLike>();
  for (const n of shown(notes, bars * STEPS_PER_BAR)) {
    if (n.start >= nSteps * STEP_TICKS) continue; // past the shown 64 steps
    // A start that rounds up to nSteps (e.g. 3830 in 1 bar) belongs to the last step.
    const i = Math.min(Math.round(n.start / STEP_TICKS), nSteps - 1);
    const held = byStep.get(i);
    if (!held || n.pitch > held.pitch) byStep.set(i, { pitch: n.pitch, vel: n.vel, start: i * STEP_TICKS, len: n.len });
  }
  const snapped = [...byStep.values()].sort((a, b) => a.start - b.start);

  const candidates = [DEFAULT_BASE, ...autoBases(snapped), 12, 24, 36, 48, 60, 72, 84, 96];
  let base = candidates.find((b) => fits(snapped, b)) ?? DEFAULT_BASE;
  if (!fits(snapped, base)) {
    const inWindow = (b: number) => snapped.filter((n) => n.pitch >= b - 12 && n.pitch <= b + 23).length;
    for (const b of candidates) if (inWindow(b) > inWindow(base)) base = b;
  }
  const folded = snapped.map((n) => {
    let pitch = n.pitch;
    while (pitch < base - 12) pitch += 12;
    while (pitch > base + 23) pitch -= 12;
    return { ...n, pitch };
  });
  return { base, steps: buildSteps(folded, nSteps, base) };
}
