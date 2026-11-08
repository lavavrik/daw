// Typed view of engine/mixer_catalog.json, the golden mixer parameter table
// (Rust test `mixer_catalog_matches_golden`). Param `id` is the wire id used in
// MIX_SET and equals the index in this array, so a ChannelState.params array
// is indexed by id. The UI never hand-copies ranges or defaults.
import raw from '../../../engine/mixer_catalog.json';

export type MixTarget = 'track' | 'return' | 'master';

/**
 * A param's knob space (the engine's `mixer::catalog::Curve`): `lin`, `exp`
 * (logarithmic), or `fader` (plan 19: the fader and both sends), the mixer
 * fader's law, `faderLaw`. Knobs, lanes and MIDI-learn all map through it
 * (ui/rack/knobMath toPos / fromPos).
 */
export type MixCurve = 'lin' | 'exp' | 'fader';

export interface MixParamDef {
  /** Wire id (MIX_SET b); equals the array index. */
  id: number;
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  curve: MixCurve;
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
  /**
   * The fader law (engine `mixer::catalog::FADER_LAW`): (dB, position)
   * breakpoints, piecewise linear in dB, position 0..1 the fader's travel.
   */
  faderLaw: readonly (readonly [number, number])[];
  /**
   * Synced delay: each delay_time choice's length in quarter-note beats, and
   * the engine's maximum delay time (a longer division is clamped to it).
   */
  delay: { divisionBeats: number[]; maxSeconds: number };
}

// Through unknown: JSON imports type `faderLaw` as number[][], not as pairs.
export const MIXER_CATALOG = raw as unknown as MixerCatalog;
export const MIX_PARAMS: MixParamDef[] = MIXER_CATALOG.params;
/** The fader law, as the engine exports it (ui/mixer/mixMath FADER_LAW). */
export const faderLaw = MIXER_CATALOG.faderLaw;

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
