// Which control draws each rack param (plan 21 Task 10; spec §11, the board
// "Rack, mechanical faceplates"). Pure; unit-tested in controlMap.test.ts.
// ModulePanel.svelte draws a module from `panelControls`:
//
// - choices: SEG_MAX_CHOICES (6) or fewer are LED push-buttons (ChoiceSeg
//   `look="led"`), more a skinned <select> (ChoiceParam);
// - vertical faders (Knob `variant="vfader"`) for levels and envelope
//   stages, the params a hardware panel puts on a slider:
//   - VFADERS below, by module: ADSR attack/decay/sustain/release, the
//     Mixer's four levels, Out level, VCA level, Noise level;
//   - plus the rule for modules not listed: a continuous, linear param
//     named `level` with the range 0..1 (a plain output level). A gain that
//     goes past 1 (Sample Player's 0..2) or a level-ish param under another
//     name (Formant's g2/g3: formant balance, not an output) stays a knob;
// - every other continuous or integer param is a mech knob (Knob
//   `variant="mech"`), in a grid of `knobColumns` columns. Sizes: the
//   module's HERO param (filter cutoff, Sample Player root, LFO rate) is
//   'lg' (86 px); knobs share the panel with faders, or a module has more
//   than COMPACT_OVER knobs (Oscillator, Formant): 'sm' (46 px); else 'md'
//   (58 px).
import type { ModuleDef, ParamDef } from '../../audio/catalog';
import { SEG_MAX_CHOICES } from './knobMath';
import type { MechSize } from './knobMath';

export type ParamControl = 'led' | 'select' | 'vfader' | 'knob';

/** Per module: the params drawn as vertical faders (the rule in `isLevel` adds the rest). */
export const VFADERS: Readonly<Record<string, readonly string[]>> = {
  adsr: ['attack', 'decay', 'sustain', 'release'],
  mixer: ['lvl1', 'lvl2', 'lvl3', 'lvl4'],
  out: ['level'],
  vca: ['level'],
  noise: ['level'],
};

/** The one param per module kind drawn as the big ('lg') dial. */
export const HERO: Readonly<Record<string, string>> = { filter: 'cutoff', sample_player: 'root', lfo: 'rate' };

/** More knobs than this in a module make them all compact ('sm'). */
export const COMPACT_OVER = 6;

/** The rule for unlisted modules: a plain 0..1 linear output level named `level`. */
const isLevel = (pd: Pick<ParamDef, 'name' | 'min' | 'max' | 'integer' | 'curve'>) =>
  pd.name === 'level' && pd.min === 0 && pd.max === 1 && !pd.integer && pd.curve === 'lin';

/** The control for param `pd` of module kind `moduleId`. */
export function paramControl(moduleId: string, pd: Pick<ParamDef, 'name' | 'min' | 'max' | 'integer' | 'curve' | 'choices'>): ParamControl {
  if (pd.choices.length) return pd.choices.length <= SEG_MAX_CHOICES ? 'led' : 'select';
  if (VFADERS[moduleId]?.includes(pd.name) || isLevel(pd)) return 'vfader';
  return 'knob';
}

/** A knob's size, given how many faders and knobs its module draws. */
export function knobSize(moduleId: string, name: string, counts: { faders: number; knobs: number }): MechSize {
  if (HERO[moduleId] === name) return 'lg';
  return counts.faders > 0 || counts.knobs > COMPACT_OVER ? 'sm' : 'md';
}

/** Grid columns for `n` knobs: 1–2 side by side, up to 4 in two columns, up to 9 in three, more in four. */
export const knobColumns = (n: number) => (n <= 2 ? Math.max(1, n) : n <= 4 ? 2 : n <= 9 ? 3 : 4);

export type Placed = { pd: ParamDef; i: number };

/**
 * A module's params by control, in catalog order (the hero knob first among
 * the knobs), without param `hidden` (Sample Player's `sample`: a dropdown).
 */
export function panelControls(def: Pick<ModuleDef, 'id' | 'params'>, hidden = -1) {
  const shown = def.params.map((pd, i) => ({ pd, i })).filter((x) => x.i !== hidden);
  const of = (c: ParamControl) => shown.filter((x) => paramControl(def.id, x.pd) === c);
  const choices = shown.filter((x) => x.pd.choices.length);
  const faders = of('vfader');
  const plain = of('knob');
  const hero = plain.filter((x) => HERO[def.id] === x.pd.name);
  const ordered = [...hero, ...plain.filter((x) => !hero.includes(x))];
  const counts = { faders: faders.length, knobs: ordered.length };
  const knobs = ordered.map((x) => ({ ...x, size: knobSize(def.id, x.pd.name, counts) }));
  return { choices, faders, knobs, cols: knobColumns(knobs.length) };
}
