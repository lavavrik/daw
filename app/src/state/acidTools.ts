// Pure pattern tools for the Acid tab (plan 17 Task 3): randomize, mutate,
// shift. They only produce AcidStep lists; acid-actions.ts writes them as notes
// (via planEdit), so nothing here knows about notes, undo or the engine.
//
// Every result is canonical (normalizeSteps): a tie never follows a rest and a
// slide only sits on a step whose next step is a note, because those are the
// only combinations the note storage can represent.
import { normalizeSteps, REST, type AcidStep } from './acidSteps';

export type ScaleName = 'minor' | 'major' | 'dorian' | 'phrygian' | 'minor pentatonic';

/** Semitone sets, relative to the root. */
export const SCALES: Record<ScaleName, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  'minor pentatonic': [0, 3, 5, 7, 10],
};

/** Step kind odds: note 70 %, tie 10 %, rest 20 %. */
const P_NOTE = 0.7;
const P_TIE = 0.8; // cumulative
const P_ACCENT = 0.3;
const P_SLIDE = 0.2;

/** One random step. `forceNote`: step 0 of a randomized pattern always sounds. */
function rollStep(root: number, scale: ScaleName, rng: () => number, forceNote: boolean): AcidStep {
  const u = rng();
  const kind = forceNote || u < P_NOTE ? 'note' : u < P_TIE ? 'tie' : 'rest';
  if (kind === 'rest') return REST;
  if (kind === 'tie') return { ...REST, kind: 'tie' };
  const degrees = SCALES[scale];
  const key = (root + degrees[Math.floor(rng() * degrees.length)]) % 12;
  const o = rng();
  const oct = o < 0.2 ? -1 : o < 0.8 ? 0 : 1; // 20 / 60 / 20
  return { kind: 'note', key, oct, accent: rng() < P_ACCENT, slide: rng() < P_SLIDE };
}

/** `len` steps of fresh random material in `scale` on `root` (0..11). */
export function randomize(len: number, root: number, scale: ScaleName, rng: () => number): AcidStep[] {
  const steps = Array.from({ length: len }, (_, i) => rollStep(root, scale, rng, i === 0));
  return normalizeSteps(steps, Math.ceil(len / 16)).slice(0, len);
}

/** Re-rolls `count` distinct random steps (fewer if the pattern is shorter). */
export function mutate(
  steps: readonly AcidStep[], root: number, scale: ScaleName, rng: () => number, count = 3,
): AcidStep[] {
  const out = steps.map((s) => ({ ...s }));
  // Partial Fisher-Yates: `count` distinct indices.
  const idx = out.map((_, i) => i);
  const n = Math.min(count, idx.length);
  for (let k = 0; k < n; k++) {
    const j = k + Math.floor(rng() * (idx.length - k));
    [idx[k], idx[j]] = [idx[j], idx[k]];
    out[idx[k]] = rollStep(root, scale, rng, false);
  }
  return normalizeSteps(out, Math.ceil(out.length / 16)).slice(0, out.length);
}

/**
 * Rotates the pattern one step later (+1) or earlier (-1); the end wraps
 * around. A tie that ends up first (its note wrapped away) becomes a rest.
 */
export function shift(steps: readonly AcidStep[], by: 1 | -1): AcidStep[] {
  const n = steps.length;
  const out = steps.map((_, i) => ({ ...steps[(i - by + n) % n] }));
  return normalizeSteps(out, Math.ceil(n / 16)).slice(0, n);
}
