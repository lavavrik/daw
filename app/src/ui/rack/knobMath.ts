// Knob maths (pure; unit-tested in knobMath.test.ts): value <-> knob position,
// drag/keyboard steps (the knob's vertical drag and the slider variant's
// horizontal drag, click-jump and fill), and the readout text.
//
// "Position" is the knob's travel, 0..1 (bottom-left .. bottom-right). Every
// gesture works in position space, so an Exp param (cutoff, envelope times)
// moves logarithmically: each pixel of drag multiplies the value by the same
// factor instead of adding Hz. A 'fader' param (the mixer fader and sends,
// plan 19) moves along the fader law (mixMath FADER_LAW), like the fader.
import { clampParam } from '../../audio/catalog';
import type { ParamDef } from '../../audio/catalog';
import type { MixCurve } from '../../audio/mixerCatalog';
import { faderKeyStep, faderLawDb, faderPos } from '../mixer/mixMath';
import { noteName } from '../noteName';

/**
 * What a knob needs to know about a param: rack params (catalog ParamDef) and
 * mixer params (mixerCatalog MixParamDef) both fit. `minLabel` is what the
 * minimum reads as ("Off", "-inf"), or absent/"" when it is just a number.
 */
export type KnobDef = Pick<ParamDef, 'label' | 'min' | 'max' | 'default' | 'integer' | 'unit' | 'choices'> & {
  /** Knob space: rack params are 'lin' / 'exp'; the mixer adds 'fader' (mixerCatalog MixCurve). */
  curve: MixCurve;
  name?: string;
  minLabel?: string;
};

/**
 * The part of a param that maps values to knob positions (toPos / fromPos):
 * any KnobDef, and what automation needs (state/automation.ts laneValueAt).
 */
export type CurveDef = Pick<KnobDef, 'min' | 'max' | 'default' | 'integer' | 'curve'>;

/** Vertical drag distance that covers the whole range (Shift = 10x finer). */
export const DRAG_PX = 150;
/** Fine-drag factor while Shift is held. */
export const FINE = 0.1;
/** Keyboard step: 1% of travel (integer params step 1 unit; fader-taper params 1 dB, see keyStep). */
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
const zeroBased = (d: CurveDef) => d.curve === 'exp' && d.min <= 0;

/**
 * Value -> position 0..1 (clamped). 'fader': the fader law (faderPos; at or
 * below the minimum, −∞ / Off, is 0), the same mapping as the engine's
 * automation `Shape` for the fader and sends.
 */
export function toPos(d: CurveDef, v: number): number {
  if (Number.isNaN(v)) v = d.default;
  if (d.max <= d.min) return 0;
  if (d.curve === 'fader') return v <= d.min ? 0 : faderPos(Math.min(v, d.max));
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

/**
 * Position 0..1 -> value, clamped to the range (integer params rounded).
 * 'fader': the law's inverse, continuous (faderLawDb: no 0.1 dB snapping, so
 * a lane or a knob drag lands exactly where the travel says).
 */
export function fromPos(d: CurveDef, pos: number): number {
  const p = clamp01(pos);
  let v: number;
  if (d.curve === 'fader') v = faderLawDb(p);
  else if (d.curve !== 'exp') v = d.min + p * (d.max - d.min);
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

/**
 * Slider variant (Knob.svelte `variant="slider"`, plan 20): the same position
 * space, laid out horizontally. Horizontal pointer travel below CLICK_SLOP_PX
 * between press and release is a click: it jumps the value to the pointer
 * (sliderPosFromX). More is a relative drag (sliderDrag). Vertical travel
 * does not count (a slider only moves sideways), so a hand that wobbles up or
 * down while clicking still clicks.
 */
export const CLICK_SLOP_PX = 3;

/** Still a click (no drag yet): under CLICK_SLOP_PX of horizontal travel from the press. */
export const isClickTravel = (downX: number, x: number) => Math.abs(x - downX) < CLICK_SLOP_PX;

/** Choice params with this many choices or fewer draw as a segmented row; more as a <select> (spec §3). */
export const SEG_MAX_CHOICES = 6;

/**
 * Position 0..1 under `clientX` on a track whose live rect (getBoundingClientRect,
 * taken at the moment it is needed, so a scrolled or zoomed container is
 * already in it) is `rect`. Clamped; a collapsed track (width 0) gives 0.
 */
export function sliderPosFromX(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return clamp01((clientX - rect.left) / rect.width);
}

/**
 * Vertical fader variant (Knob.svelte `variant="vfader"`, plan 21): position
 * 0..1 under `clientY` on a slot whose live rect is `rect`, bottom = 0, top
 * = 1. Clamped; a collapsed slot (height 0) gives 0. Its drag is
 * sliderDrag with the upward travel (-dy) and the slot's height, and a click
 * is isClickTravel on the y axis.
 */
export function sliderPosFromY(clientY: number, rect: { top: number; height: number }): number {
  if (!(rect.height > 0)) return 0;
  return clamp01((rect.top + rect.height - clientY) / rect.height);
}

/** Mech dial sizes in px (plan 21, spec §11): the hero param, the default, compact (mixer strips, beside faders). */
export const MECH_DIAL_PX = { lg: 86, md: 58, sm: 46 } as const;
export type MechSize = keyof typeof MECH_DIAL_PX;

/**
 * The mech dial's ring of 11 ticks, as one SVG path in its 100×100 box
 * (centre 50,50): from 135° (bottom-left) clockwise over the 270° travel,
 * radius 45 out to 48, every 5th (min, centre, max) out to 50. The board's
 * geometry ("Rack, mechanical faceplates").
 */
export const MECH_TICKS = (() => {
  let d = '';
  for (let i = 0; i <= 10; i++) {
    const a = ((135 + 27 * i) * Math.PI) / 180;
    const r2 = i % 5 === 0 ? 50 : 48;
    const p = (r: number) => `${(50 + r * Math.cos(a)).toFixed(1)} ${(50 + r * Math.sin(a)).toFixed(1)}`;
    d += `M${p(45)}L${p(r2)}`;
  }
  return d;
})();

/**
 * New position after a horizontal drag of `dx` px (right = more) on a track
 * `widthPx` wide: the track's width is the full range; `fine` (Shift) is 10x finer.
 */
export function sliderDrag(pos: number, dx: number, widthPx: number, fine: boolean): number {
  if (!(widthPx > 0)) return pos;
  return clamp01(pos + (dx / widthPx) * (fine ? FINE : 1));
}

/**
 * The slider's filled part, [from, to] in positions. Bipolar params (an
 * offset: min < 0 < max, like pan, EQ gains, cv amount, octave) fill from
 * zero towards the value; the rest from the left. A 'fader' param (the sends'
 * dB) is a level, not an offset, so it fills from the left even though its
 * range crosses 0 dB.
 */
export function fillSpan(d: CurveDef, v: number): [number, number] {
  const p = toPos(d, v);
  if (d.curve === 'fader' || !(d.min < 0 && d.max > 0)) return [0, p];
  const z = toPos(d, 0);
  return [Math.min(z, p), Math.max(z, p)];
}

/**
 * One keyboard step up (dir 1) or down (dir -1); `fine` = 0.1% of travel.
 * A 'fader' param (a send knob) steps like the fader's keys instead: 1 dB
 * (fine 0.1 dB) on the 0.1 dB grid (mixMath faderKeyStep; up from Off is
 * −59 dB), so the keys land on exact values and up-then-down returns home.
 */
export function keyStep(d: KnobDef, v: number, dir: 1 | -1, fine = false): number {
  if (d.integer) return clampParam(d, Math.round(v) + dir);
  if (d.curve === 'fader') return clampParam(d, faderKeyStep(v, dir, fine));
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
 * A MIDI note param (isNoteParam: the Sample Player's `root`) -> its note
 * name, "C4" for 60.
 */
export function formatValue(d: KnobDef, v: number): string {
  if (d.choices.length) return d.choices[Math.round(v)] ?? String(v);
  if (d.minLabel && v <= d.min) return minLabelText(d.minLabel);
  const bipolar = d.min < 0;
  // A linear param that reaches zero (tune, detune, a bipolar amount): what is
  // under a thousandth of the range reads as 0, not as "0.0843 st" with a
  // digit more than the chip's fixed width (widestValue) has room for.
  if (d.curve === 'lin' && d.min <= 0 && !d.integer && Math.abs(v) < (d.max - d.min) / 1000) v = 0;
  if (isNoteParam(d)) return noteName(Math.round(v));
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
 * The width, in characters, of the widest readout `formatValue` can produce
 * for `d` anywhere in its range. The value chip takes this as its `min-width`
 * (in `ch`, tabular numerals), so no value (a decimal that appears, ms -> s,
 * "-inf", "off") can change the chip's width, nor the module's or the
 * mixer strip's. Candidates: the range's min, max and default, plus a dense
 * sweep of knob positions (so unit changes and every significant-digit
 * pattern in between are seen). Choice params have no chip (their buttons
 * are fixed), so they measure their longest choice.
 */
const widestCache = new WeakMap<KnobDef, number>();
export function widestValue(d: KnobDef): number {
  // ~2000 formatValue calls per param: once per def, not per Knob mount (every
  // rack knob and every mixer strip's). Defs are the catalog's own objects.
  const known = widestCache.get(d);
  if (known !== undefined) return known;
  const w = measureWidest(d);
  widestCache.set(d, w);
  return w;
}
function measureWidest(d: KnobDef): number {
  if (d.choices.length) return Math.max(...d.choices.map((c) => c.length));
  const SWEEP = 2000;
  const seen = [d.min, d.max, d.default];
  for (let i = 0; i <= SWEEP; i++) seen.push(fromPos(d, i / SWEEP));
  // Every decade's widest 3-digit patterns (1.11, 9.99 x 10^k), both signs,
  // so a sweep that happens to skip them (near zero, or just under a unit
  // change such as 999 ms) cannot hide the widest string.
  const span = Math.max(Math.abs(d.min), Math.abs(d.max));
  for (let k = Math.floor(Math.log10(span)) + 1; k >= -6; k--) {
    for (const m of [1.11, 9.99]) for (const sg of [1, -1]) {
      const v = sg * m * 10 ** k;
      if (v >= d.min && v <= d.max) seen.push(v);
    }
  }
  let widest = 0;
  for (const v of seen) widest = Math.max(widest, [...formatValue(d, v)].length);
  return widest;
}

/** A MIDI note number param, shown and typed as a note name: the Sample Player's `root` (0..127, integer, no unit). */
export const isNoteParam = (d: KnobDef) => d.name === 'root' && d.integer && d.unit === '' && d.min >= 0 && d.max <= 127;

const NOTE_STEPS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
// Solfège syllables → letter steps ("sol" and "so" both read as G).
const SOLFEGE_STEPS: Record<string, number> = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, so: 7, la: 9, si: 11, ti: 11 };
/**
 * "E4" → 64, "c#3" → 49, "Db4" → 61, "C-1" → 0 (C4 = 60, as noteName); also the
 * solfège form whatever the display setting: "Mi4", "do♯3", "Sol4", "Reb2".
 * null if it isn't one.
 */
export function parseNoteName(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[−–]/g, '-').replace('♯', '#').replace('♭', 'b');
  const m = /^(do|re|mi|fa|sol|so|la|si|ti|[a-g])([#b]?) ?(-?\d+)$/.exec(t);
  if (!m) return null;
  const step = m[1].length === 1 ? NOTE_STEPS[m[1]] : SOLFEGE_STEPS[m[1]];
  return step + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

/** Typed text, compared loosely: lower case, ASCII minus, "." decimals, single spaces. */
const normText = (s: string) => s.trim().toLowerCase().replace(/[−–]/g, '-').replace(',', '.').replace(/\s+/g, ' ');

/** What the minimum reads as, normalised (normText): its minLabel's forms, or a zero-based time's "off". */
function minLabels(d: KnobDef): string[] {
  if (d.minLabel) {
    const l = [normText(d.minLabel), normText(minLabelText(d.minLabel))];
    return d.minLabel === '-inf' ? [...l, '-∞', '∞', '-inf', 'inf'] : l;
  }
  return d.unit === 's' && d.min <= 0 ? ['off'] : [];
}

/** The units the param's readout can show, normalised, longest first ("khz" before "hz"). */
function displayUnits(d: KnobDef): string[] {
  if (d.unit === 'Hz') return ['khz', 'hz', 'k'];
  if (d.unit === 's') return ['sec', 'ms', 's'];
  return d.unit ? [d.unit.toLowerCase()] : [];
}

/** `t` (normalised) is the minimum's label, alone or followed by one of the param's units. */
function isMinLabel(d: KnobDef, labels: string[], t: string): boolean {
  if (!labels.length || !t) return false;
  if (labels.includes(t)) return true;
  const u = displayUnits(d).find((x) => t.endsWith(x));
  return !!u && labels.includes(t.slice(0, -u.length).trimEnd());
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
 *   pan  "C", "L30", "R 100", or the raw -1..1 ("-0.25", "-25%");
 *   min  the minimum's label ("−∞", "-inf", "Off", a zero-based time's
 *        "off"), any case, alone or followed by a unit the param shows
 *        ("-inf dB", "Off kHz", "off s"): retyping what is shown always works
 *   -1..1 amounts (unitless, bipolar): "-0.5" or "-50%"
 *   note "E4", "c#3", "Db4", "Mi4", "sol3" (or the MIDI number) for a note param (root)
 * A bare number is read in the unit the readout currently shows (`shown`):
 * with "1.2 kHz" on screen, "2" means 2 kHz; with "12 ms", "30" means 30 ms.
 * When the readout is the minimum's label ("Off", "off", "−∞"), it has no
 * unit, so a bare number is read in the unit the param shows at its
 * maximum: the EQ's high-pass at "Off" (max "1 kHz") reads "1" as 1 kHz,
 * glide at "off" (max "2 s") reads "0.5" as 0.5 s.
 */
export function parseValue(d: KnobDef, text: string, shown = ''): number | null {
  const t = normText(text);
  if (!t) return null;
  const done = (v: number) => (Number.isFinite(v) ? clampParam(d, v) : null);

  if (d.choices.length) {
    const i = d.choices.findIndex((c) => c.toLowerCase() === t);
    if (i >= 0) return i;
    const n = Number(t);
    return Number.isInteger(n) ? done(n) : null;
  }
  const labels = minLabels(d);
  if (isMinLabel(d, labels, t)) return d.minLabel ? d.min : done(0);
  if (d.name === 'pan' && d.unit === '') {
    if (t === 'c' || t === 'center' || t === 'centre') return 0;
    const m = /^([lr]) ?(\d*\.?\d+) ?%?$/.exec(t);
    if (m) return done(((m[1] === 'l' ? -1 : 1) * Number(m[2])) / 100);
  }
  if (isNoteParam(d)) {
    const n = parseNoteName(t);
    if (n !== null) return done(n);
  }

  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)) ?([a-z%:0-9]*)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const suf = m[2];
  // The unit a bare number is in: the readout's, or the maximum's when the
  // readout is the minimum's label (header).
  let sh = normText(shown);
  if (isMinLabel(d, labels, sh)) sh = normText(formatValue(d, d.max));
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
      // A bipolar amount (the attenuator's -1..1) reads "-0.5"; "-50%" is
      // the same value, as on the unipolar percent params.
      if (suf === '%' && !d.integer && d.min < 0) return done(n / 100);
      return suf === '' ? done(n) : null;
    default:
      return suf === '' || suf === d.unit.toLowerCase() ? done(n) : null;
  }
}

/**
 * The precise-value popover's field (ui/ValuePopover.svelte): the readout
 * split into the text to edit and the unit shown as the field's suffix.
 * "1.2 kHz" -> "1.2" + "kHz", "-6.0 dB" -> "-6.0" + "dB" (ASCII minus, easy
 * to edit), "45%" -> "45" + "%", "4:1" -> "4" + ":1". The suffix is only
 * ever a unit after a number: a readout without one is the text whole with
 * no suffix, whether a unitless decimal ("0.7", "-0.5": never split at the
 * point), a note name ("C4"), pan ("L50"), an integer, or the minimum's
 * label ("−∞", "Off", "off"). parseValue reads the text back with the
 * readout as `shown` (a bare "2" next to "kHz" is 2 kHz; next to a label,
 * the maximum's unit) and accepts the text and unit typed together.
 */
export function entryParts(d: KnobDef, v: number): { text: string; unit: string } {
  const s = formatValue(d, v).replace(/−/g, '-');
  // The unit may not start with a digit or ".": "0.7" must not split into "0" + ".7".
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)) ?([^\d\s.].*)$/.exec(s);
  return m ? { text: m[1], unit: m[2] } : { text: s, unit: '' };
}
