// Knob maths (pure; unit-tested in knobMath.test.ts): value <-> knob position,
// drag/keyboard steps, and the readout text.
//
// "Position" is the knob's travel, 0..1 (bottom-left .. bottom-right). Every
// gesture works in position space, so an Exp param (cutoff, envelope times)
// moves logarithmically: each pixel of drag multiplies the value by the same
// factor instead of adding Hz.
import { clampParam } from '../../audio/catalog';
import type { ParamDef } from '../../audio/catalog';

/**
 * What a knob needs to know about a param: rack params (catalog ParamDef) and
 * mixer params (mixerCatalog MixParamDef) both fit. `minLabel` is what the
 * minimum reads as ("Off", "-inf"), or absent/"" when it is just a number.
 */
export type KnobDef = Pick<ParamDef, 'label' | 'min' | 'max' | 'default' | 'integer' | 'curve' | 'unit' | 'choices'> & {
  name?: string;
  minLabel?: string;
};

/** Vertical drag distance that covers the whole range (Shift = 10x finer). */
export const DRAG_PX = 150;
/** Fine-drag factor while Shift is held. */
export const FINE = 0.1;
/** Keyboard step: 1% of travel (integer params step 1 unit instead). */
export const KEY_STEP = 0.01;

/**
 * Exp params whose min is 0 (MIDI In glide, 0..2 s) cannot be logarithmic all
 * the way down. Mapping: the bottom ZERO_ZONE (2%) of travel is exactly 0
 * ("off"), and the rest is logarithmic from `max / EXP_FLOOR_RATIO` (2 ms for
 * glide) up to max. A tiny glide is inaudible anyway, while "off" must be
 * reachable exactly.
 */
export const ZERO_ZONE = 0.02;
export const EXP_FLOOR_RATIO = 1000;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const zeroBased = (d: KnobDef) => d.curve === 'exp' && d.min <= 0;

/** Value -> position 0..1 (clamped). */
export function toPos(d: KnobDef, v: number): number {
  if (Number.isNaN(v)) v = d.default;
  if (d.max <= d.min) return 0;
  if (d.curve !== 'exp') return clamp01((v - d.min) / (d.max - d.min));
  if (zeroBased(d)) {
    if (v <= 0) return 0;
    const floor = d.max / EXP_FLOOR_RATIO;
    if (v <= floor) return ZERO_ZONE;
    return clamp01(ZERO_ZONE + (1 - ZERO_ZONE) * (Math.log(v / floor) / Math.log(d.max / floor)));
  }
  if (v <= d.min) return 0;
  return clamp01(Math.log(v / d.min) / Math.log(d.max / d.min));
}

/** Position 0..1 -> value, clamped to the range (integer params rounded). */
export function fromPos(d: KnobDef, pos: number): number {
  const p = clamp01(pos);
  let v: number;
  if (d.curve !== 'exp') v = d.min + p * (d.max - d.min);
  else if (zeroBased(d)) {
    if (p < ZERO_ZONE) return clampParam(d, 0);
    const floor = d.max / EXP_FLOOR_RATIO;
    v = floor * Math.pow(d.max / floor, (p - ZERO_ZONE) / (1 - ZERO_ZONE));
  } else v = d.min * Math.pow(d.max / d.min, p);
  return clampParam(d, v);
}

/** New position after a vertical drag of `dy` px (screen y: negative = up = more). */
export function dragPos(pos: number, dy: number, fine: boolean): number {
  return clamp01(pos - (dy / DRAG_PX) * (fine ? FINE : 1));
}

/** One keyboard step up (dir 1) or down (dir -1); `fine` = 0.1% of travel. */
export function keyStep(d: KnobDef, v: number, dir: 1 | -1, fine = false): number {
  if (d.integer) return clampParam(d, Math.round(v) + dir);
  // From "off", a step up must leave the zero zone (1% would land inside it
  // and stay 0): go straight to the floor, the smallest non-zero value.
  if (zeroBased(d) && v <= 0 && dir > 0) return fromPos(d, ZERO_ZONE);
  return fromPos(d, toPos(d, v) + dir * KEY_STEP * (fine ? FINE : 1));
}

/** 3 significant digits without trailing zeros: 300, 1.23, 0.25, 12.3. */
function sig3(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  const s = a >= 1000 ? String(Math.round(a)) : String(Number(a.toPrecision(3)));
  return (x < 0 ? '-' : '') + s;
}

/** Signed with a real minus sign ("+3", "−2", "0"). */
function signed(x: number): string {
  const s = sig3(x);
  if (s === '0') return '0';
  return x > 0 ? `+${s}` : `−${s.slice(1)}`;
}

/** The catalog's minLabel as shown ("-inf" -> "−∞" with real minus and infinity signs). */
export function minLabelText(label: string): string {
  return label === '-inf' ? '−∞' : label;
}

/**
 * Readout text. Hz -> "300 Hz" / "1.2 kHz"; s -> "250 ms" / "1.5 s" ("off" at
 * 0 for zero-based times like glide); oct/st/ct -> signed when the range is
 * bipolar (an offset), plain when unipolar (an amount, e.g. bend range);
 * unitless 0..1 -> percent; choices -> the choice label.
 * Mixer additions: a param at its minimum shows its minLabel ("Off", "−∞");
 * dB -> one decimal ("−18.0 dB", "+3.0 dB" when bipolar); ":1" -> "4:1";
 * the "pan" param -> "L50" / "C" / "R100" (percent of the way to the side).
 */
export function formatValue(d: KnobDef, v: number): string {
  if (d.choices.length) return d.choices[Math.round(v)] ?? String(v);
  if (d.minLabel && v <= d.min) return minLabelText(d.minLabel);
  const bipolar = d.min < 0;
  if (d.name === 'pan' && d.unit === '') {
    const pct = Math.round(Math.abs(v) * 100);
    return pct === 0 ? 'C' : `${v < 0 ? 'L' : 'R'}${pct}`;
  }
  // Round first so 999.7 Hz reads "1 kHz", not "1000 Hz".
  const r3 = Math.abs(Number(v.toPrecision(3)));
  switch (d.unit) {
    case 'Hz':
      return r3 >= 1000 ? `${sig3(v / 1000)} kHz` : `${sig3(v)} Hz`;
    case 's':
      if (v === 0 && d.min <= 0) return 'off';
      return r3 < 1 ? `${sig3(v * 1000)} ms` : `${sig3(v)} s`;
    case 'oct':
    case 'st':
    case 'ct':
      return `${bipolar ? signed(v) : sig3(v)} ${d.unit}`;
    case 'dB': {
      const t = Math.abs(v).toFixed(1);
      if (t === '0.0') return '0.0 dB';
      return `${v < 0 ? '−' : bipolar ? '+' : ''}${t} dB`;
    }
    case ':1':
      return `${sig3(v)}:1`;
    case '':
      if (!d.integer && d.min >= 0 && d.max <= 1) return `${Math.round(v * 100)}%`;
      return d.integer ? String(Math.round(v)) : sig3(v);
    default:
      return `${sig3(v)} ${d.unit}`;
  }
}

/**
 * Typed entry (click a knob's readout, or Enter on a focused knob): text ->
 * value, clamped to the range (integers rounded), or null when it doesn't
 * read as a value of this param. Accepts what formatValue shows and the
 * obvious shorthands:
 *   Hz   "440", "440 Hz", "1.2k", "1.2 kHz"
 *   s    "250 ms", "1.5 s", "off" (zero-based times)
 *   ms   "20", "20 ms", "0.02 s"
 *   dB / st / oct / ct / :1 — the number, unit optional; "−" or "-" alike
 *   0..1 "45%" or "45" (percent); a decimal ≤ 1 ("0.3") is the raw value
 *   pan  "C", "L30", "R 100"; minimum labels ("−∞", "-inf", "Off")
 * A bare number is read in the unit the readout currently shows (`shown`):
 * with "1.2 kHz" on screen, "2" means 2 kHz; with "12 ms", "30" means 30 ms.
 */
export function parseValue(d: KnobDef, text: string, shown = ''): number | null {
  const t = text.trim().toLowerCase().replace(/[−–]/g, '-').replace(',', '.').replace(/\s+/g, ' ');
  if (!t) return null;
  const done = (v: number) => (Number.isFinite(v) ? clampParam(d, v) : null);

  if (d.choices.length) {
    const i = d.choices.findIndex((c) => c.toLowerCase() === t);
    if (i >= 0) return i;
    const n = Number(t);
    return Number.isInteger(n) ? done(n) : null;
  }
  if (d.minLabel) {
    const ml = minLabelText(d.minLabel).toLowerCase();
    if (t === ml || t === d.minLabel.toLowerCase() || (d.minLabel === '-inf' && (t === '-∞' || t === '-inf' || t === 'inf'))) return d.min;
  }
  if (d.name === 'pan' && d.unit === '') {
    if (t === 'c' || t === 'center' || t === 'centre') return 0;
    const m = /^([lr]) ?(\d*\.?\d+) ?%?$/.exec(t);
    if (m) return done(((m[1] === 'l' ? -1 : 1) * Number(m[2])) / 100);
  }
  if (d.unit === 's' && d.min <= 0 && t === 'off') return done(0);

  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)) ?([a-z%:0-9]*)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const suf = m[2];
  const sh = shown.trim().toLowerCase();
  switch (d.unit) {
    case 'Hz':
      if (suf === 'k' || suf === 'khz') return done(n * 1000);
      if (suf === 'hz') return done(n);
      if (suf === '') return done(sh.endsWith('khz') ? n * 1000 : n);
      return null;
    case 's':
      if (suf === 'ms') return done(n / 1000);
      if (suf === 's' || suf === 'sec') return done(n);
      if (suf === '') return done(sh.endsWith(' ms') ? n / 1000 : n);
      return null;
    case 'ms':
      if (suf === 's' || suf === 'sec') return done(n * 1000);
      if (suf === 'ms' || suf === '') return done(n);
      return null;
    case '':
      if (!d.integer && d.min >= 0 && d.max <= 1) {
        if (suf === '%') return done(n / 100);
        if (suf !== '') return null;
        return done(m[1].includes('.') && n <= 1 ? n : n / 100);
      }
      return suf === '' ? done(n) : null;
    default:
      return suf === '' || suf === d.unit.toLowerCase() ? done(n) : null;
  }
}
