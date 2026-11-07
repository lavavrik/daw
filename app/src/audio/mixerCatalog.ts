// Typed view of engine/mixer_catalog.json, the golden mixer parameter table
// (Rust test `mixer_catalog_matches_golden`). Param `id` is the wire id used in
// MIX_SET and equals the index in this array, so a ChannelState.params array
// is indexed by id. The UI never hand-copies ranges or defaults.
import raw from '../../../engine/mixer_catalog.json';

export type MixTarget = 'track' | 'return' | 'master';

export interface MixParamDef {
  /** Wire id (MIX_SET b); equals the array index. */
  id: number;
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  curve: 'lin' | 'exp';
  integer: boolean;
  appliesTo: MixTarget[];
  group: string;
  /** Labels for enum-like params (value = index); empty for continuous ones. */
  choices: string[];
  /** What the minimum value is shown as ("-inf", "Off"), or "" when it is just a number. */
  minLabel: string;
}

export interface MixerCatalog {
  version: number;
  channels: { tracks: number; reverb: number; delay: number; master: number };
  params: MixParamDef[];
}

export const MIXER_CATALOG = raw as MixerCatalog;
export const MIX_PARAMS: MixParamDef[] = MIXER_CATALOG.params;

/** Look up by name ("fader"). Throws on unknown. */
export function mixParam(name: string): MixParamDef {
  const d = MIX_PARAMS.find((p) => p.name === name);
  if (!d) throw new Error(`unknown mixer param ${name}`);
  return d;
}

/** A fresh params array in catalog order, defaults filled in. */
export function defaultMixParams(): number[] {
  return MIX_PARAMS.map((p) => p.default);
}

/**
 * Clamp to [min,max]; integer params also round. NaN falls back to the
 * default. -Infinity (a "-inf"/"Off" request) lands on the minimum, which the
 * engine treats as off for the params that have a minLabel.
 */
export function clampMix(def: MixParamDef, v: number): number {
  if (Number.isNaN(v)) return def.default;
  const c = Math.min(def.max, Math.max(def.min, v));
  return def.integer ? Math.round(c) : c;
}
