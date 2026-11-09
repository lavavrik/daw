import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../../audio/catalog';
import type { ParamDef } from '../../audio/catalog';
import { MIX_PARAMS, mixParam } from '../../audio/mixerCatalog';
import { FADER_LAW, faderDb, faderKeyStep, faderPos, formatDb } from '../mixer/mixMath';
import {
  CLICK_SLOP_PX, DRAG_PX, MECH_DIAL_PX, MECH_TICKS, isClickTravel, dragPos, fillSpan, formatValue, fromPos, keyStep, parseValue, sliderDrag, sliderPosFromX, sliderPosFromY,
  toPos, widestValue, ZERO_ZONE,
} from './knobMath';

const param = (mod: string, name: string): ParamDef => {
  const d = moduleDef(mod);
  return d.params[paramIndex(d, name)];
};
const cutoff = param('filter', 'cutoff'); // 20..20000 exp Hz
const glide = param('midi_in', 'glide'); // 0..2 exp s
const reso = param('filter', 'reso'); // 0..1 lin
const octave = param('osc', 'octave'); // -3..3 int oct
const attack = param('adsr', 'attack'); // 0.001..10 exp s

describe('toPos / fromPos', () => {
  it('lin maps min..max to 0..1', () => {
    expect(toPos(reso, 0)).toBe(0);
    expect(toPos(reso, 1)).toBe(1);
    expect(toPos(reso, 0.25)).toBeCloseTo(0.25);
    expect(fromPos(reso, 0.4)).toBeCloseTo(0.4);
  });

  it('exp is logarithmic: geometric mean sits at the middle', () => {
    expect(toPos(cutoff, 20)).toBe(0);
    expect(toPos(cutoff, 20000)).toBeCloseTo(1);
    expect(toPos(cutoff, Math.sqrt(20 * 20000))).toBeCloseTo(0.5);
    expect(fromPos(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000));
  });

  it('round-trips for every catalog param', () => {
    for (const pd of moduleDef('osc').params.concat(moduleDef('adsr').params, moduleDef('midi_in').params)) {
      for (const pos of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
        const v = fromPos(pd, pos);
        expect(v).toBeGreaterThanOrEqual(pd.min);
        expect(v).toBeLessThanOrEqual(pd.max);
        const zeroZone = pd.curve === 'exp' && pd.min === 0 && pos < ZERO_ZONE;
        if (!pd.integer) expect(toPos(pd, v)).toBeCloseTo(zeroZone ? 0 : pos);
      }
    }
  });

  it('integer params round', () => {
    expect(fromPos(octave, 0.5)).toBe(0);
    expect(fromPos(octave, 0.6)).toBe(1);
    expect(Number.isInteger(fromPos(octave, 0.77))).toBe(true);
  });

  it('exp with min 0 (glide): bottom 2% of travel is exactly 0, then log from a floor', () => {
    expect(fromPos(glide, 0)).toBe(0);
    expect(fromPos(glide, ZERO_ZONE / 2)).toBe(0);
    expect(fromPos(glide, ZERO_ZONE + 0.001)).toBeGreaterThan(0);
    expect(fromPos(glide, ZERO_ZONE + 0.001)).toBeLessThan(0.005);
    expect(fromPos(glide, 1)).toBeCloseTo(2);
    expect(toPos(glide, 0)).toBe(0);
    expect(toPos(glide, 2)).toBeCloseTo(1);
    // log in between: equal position steps multiply the value
    const a = fromPos(glide, 0.4), b = fromPos(glide, 0.6), c = fromPos(glide, 0.8);
    expect(b / a).toBeCloseTo(c / b);
  });

  it('clamps out-of-range inputs', () => {
    expect(toPos(cutoff, 5)).toBe(0);
    expect(toPos(cutoff, 1e6)).toBe(1);
    expect(fromPos(reso, -1)).toBe(0);
    expect(fromPos(reso, 2)).toBe(1);
  });
});

// Plan 19: the fader and both sends have curve 'fader', the mixer fader's
// law (mixMath FADER_LAW, from the catalog). Their knob space is the fader's
// travel, continuous both ways (no 0.1 dB snapping, unlike the fader drag).
describe('toPos / fromPos: the fader taper', () => {
  const send = mixParam('send_a');
  const fader = mixParam('fader');
  it('the fader and both sends use it; nothing else does', () => {
    expect([fader.curve, send.curve, mixParam('send_b').curve]).toEqual(['fader', 'fader', 'fader']);
    expect(mixParam('pan').curve).toBe('lin');
    expect(mixParam('comp_threshold').curve).toBe('lin');
  });
  it('round-trips at each breakpoint and between them', () => {
    for (const d of [fader, send]) {
      for (const [db, pos] of FADER_LAW) {
        expect(toPos(d, db)).toBeCloseTo(pos, 12);
        expect(fromPos(d, pos)).toBeCloseTo(db, 9);
      }
      for (let i = 1; i < FADER_LAW.length; i++) {
        const [d0, p0] = FADER_LAW[i - 1];
        const [d1, p1] = FADER_LAW[i];
        for (const f of [0.1, 0.5, 0.83]) {
          const db = d0 + f * (d1 - d0);
          expect(toPos(d, db), `${db} dB`).toBeCloseTo(p0 + f * (p1 - p0), 12);
          expect(fromPos(d, toPos(d, db))).toBeCloseTo(db, 9);
          expect(toPos(d, db)).toBe(faderPos(db)); // the fader's own law
        }
      }
    }
  });
  it('position -> dB is continuous: no 0.1 dB snapping', () => {
    // Half way is between (-20, 0.38) and (-10, 0.55): -20 + 10 * 0.12 / 0.17.
    expect(fromPos(send, 0.5)).toBeCloseTo(-20 + (10 * 0.12) / 0.17, 12);
    expect(faderDb(0.5)).toBe(-12.9); // the on-screen fader drag still snaps
    expect(fromPos(send, 0.4)).not.toBe(Math.round(fromPos(send, 0.4) * 10) / 10);
  });
  it('at or below the minimum is position 0; the ends clamp', () => {
    for (const v of [-60, -61, -Infinity]) expect(toPos(send, v)).toBe(0);
    expect(toPos(send, 6)).toBe(1);
    expect(toPos(send, 40)).toBe(1);
    expect(fromPos(send, 0)).toBe(-60);
    expect(fromPos(send, -1)).toBe(-60);
    expect(fromPos(send, 2)).toBe(6);
    expect(toPos(send, NaN)).toBe(0); // the default (Off)
    expect(toPos(fader, NaN)).toBe(0.75); // the default (0 dB)
  });
  it('a drag moves like the fader: the bottom 14% of travel is -60..-40 dB', () => {
    expect(fromPos(send, dragPos(0, -0.14 * DRAG_PX, false))).toBeCloseTo(-40, 9);
    expect(fromPos(send, dragPos(toPos(send, 0), -0.25 * DRAG_PX, false))).toBeCloseTo(6, 9);
  });
});

describe('dragPos', () => {
  it('150 px upward covers the full range; Shift is x0.1', () => {
    expect(DRAG_PX).toBe(150);
    expect(dragPos(0, -150, false)).toBe(1);
    expect(dragPos(0, -75, false)).toBeCloseTo(0.5);
    expect(dragPos(0.5, 75, false)).toBeCloseTo(0);
    expect(dragPos(0.5, -150, true)).toBeCloseTo(0.6);
    expect(dragPos(0.9, -300, false)).toBe(1);
  });
});

// Plan 20 Task 3: the slider variant's maths (horizontal, relative drag; click-jump; fill).
describe('slider maths', () => {
  const rect = { left: 100, width: 200 };

  it('sliderPosFromX: the track\'s live rect maps clientX to 0..1, clamped', () => {
    expect(sliderPosFromX(100, rect)).toBe(0);
    expect(sliderPosFromX(150, rect)).toBeCloseTo(0.25);
    expect(sliderPosFromX(300, rect)).toBe(1);
    expect(sliderPosFromX(20, rect)).toBe(0);
    expect(sliderPosFromX(999, rect)).toBe(1);
    // A scrolled container just moves the rect: the same offset into it gives the same position.
    expect(sliderPosFromX(150 - 640, { left: 100 - 640, width: 200 })).toBeCloseTo(0.25);
    expect(sliderPosFromX(150, { left: 100, width: 0 })).toBe(0); // collapsed (hidden) track
  });

  it('sliderDrag: the track width is the full range, relative; Shift is 10x finer', () => {
    expect(sliderDrag(0, 200, 200, false)).toBe(1);
    expect(sliderDrag(0.2, 100, 200, false)).toBeCloseTo(0.7);
    expect(sliderDrag(0.7, -100, 200, false)).toBeCloseTo(0.2);
    expect(sliderDrag(0.5, 200, 200, true)).toBeCloseTo(0.6);
    expect(sliderDrag(0.9, 400, 200, false)).toBe(1);
    expect(sliderDrag(0.1, -400, 200, false)).toBe(0);
    expect(sliderDrag(0.4, 50, 0, false)).toBe(0.4); // no width: no move
  });

  it('a slider drag in position space: exp params move logarithmically, like the knob', () => {
    expect(fromPos(cutoff, sliderDrag(toPos(cutoff, 20), 100, 200, false))).toBeCloseTo(Math.sqrt(20 * 20000));
  });

  it('sliderPosFromY (vertical fader): the bottom of the live rect is 0, the top 1, clamped', () => {
    const r = { top: 50, height: 100 };
    expect(sliderPosFromY(150, r)).toBe(0);
    expect(sliderPosFromY(50, r)).toBe(1);
    expect(sliderPosFromY(125, r)).toBeCloseTo(0.25);
    expect(sliderPosFromY(400, r)).toBe(0);
    expect(sliderPosFromY(-10, r)).toBe(1);
    expect(sliderPosFromY(125 - 300, { top: 50 - 300, height: 100 })).toBeCloseTo(0.25); // scrolled
    expect(sliderPosFromY(80, { top: 50, height: 0 })).toBe(0); // collapsed
  });

  it('a vertical fader drag is sliderDrag with the travel up: the slot height is the full range', () => {
    // Knob.svelte passes -dy (screen y grows downward).
    expect(sliderDrag(0.2, -(-50), 100, false)).toBeCloseTo(0.7);
    expect(sliderDrag(0.2, -(-50), 100, true)).toBeCloseTo(0.25);
  });

  it('a click is less than CLICK_SLOP_PX of horizontal travel; vertical travel does not count', () => {
    expect(CLICK_SLOP_PX).toBe(3);
    expect(isClickTravel(100, 100)).toBe(true);
    expect(isClickTravel(100, 102.9)).toBe(true);
    expect(isClickTravel(100, 97.1)).toBe(true);
    expect(isClickTravel(100, 103)).toBe(false);
    expect(isClickTravel(100, 97)).toBe(false);
  });

  it('fillSpan: unipolar params fill from the left, bipolar ones from zero', () => {
    expect(fillSpan(reso, 0.3)).toEqual([0, expect.closeTo(0.3)]);
    const cvAmt = param('filter', 'cv_amt'); // -8..8
    expect(fillSpan(cvAmt, 0)).toEqual([0.5, 0.5]);
    expect(fillSpan(cvAmt, 4)).toEqual([0.5, expect.closeTo(0.75)]);
    expect(fillSpan(cvAmt, -8)).toEqual([0, 0.5]);
    const pan = mixParam('pan'); // -1..1
    expect(fillSpan(pan, -0.5)).toEqual([expect.closeTo(0.25), 0.5]);
    expect(fillSpan(octave, -3)).toEqual([0, 0.5]); // integer bipolar too
    // A fader-taper level (the sends: dB up to +6) is a level, not an offset: from the left.
    const send = mixParam('send_a');
    expect(fillSpan(send, 0)).toEqual([0, expect.closeTo(toPos(send, 0))]);
  });
});

describe('keyStep', () => {
  it('steps 1% of travel (in curve space), 1 unit for integers', () => {
    expect(keyStep(reso, 0.5, 1)).toBeCloseTo(0.51);
    expect(keyStep(reso, 0.5, -1)).toBeCloseTo(0.49);
    expect(keyStep(octave, 0, 1)).toBe(1);
    expect(keyStep(octave, 3, 1)).toBe(3);
    expect(keyStep(cutoff, 300, 1)).toBeCloseTo(fromPos(cutoff, toPos(cutoff, 300) + 0.01));
  });
  it('a zero-based exp param (glide) can be turned on from "off" with the keys', () => {
    expect(keyStep(glide, 0, 1)).toBeGreaterThan(0);
    expect(keyStep(glide, 0, 1, true)).toBeGreaterThan(0);
    expect(keyStep(glide, keyStep(glide, 0, 1), -1)).toBe(0); // and back off
    expect(keyStep(glide, 0, -1)).toBe(0);
  });
  it('fader-taper params (fader, sends) step like the fader: 1 dB, Shift 0.1 dB, on exact values', () => {
    const send = mixParam('send_a');
    expect(keyStep(send, -12.3, 1)).toBe(-11.3);
    expect(keyStep(send, -12.3, -1, true)).toBe(-12.4);
    expect(keyStep(send, -60, 1)).toBe(-59); // up from Off
    expect(keyStep(send, -60, -1)).toBe(-60);
    expect(keyStep(send, 6, 1)).toBe(6);
    // Up and back down returns to the same value, no drift.
    let v = -12.3;
    for (let i = 0; i < 25; i++) v = keyStep(send, v, 1, true);
    for (let i = 0; i < 25; i++) v = keyStep(send, v, -1, true);
    expect(v).toBe(-12.3);
    for (const db of [-60, -33.3, -0.1, 0, 5.5]) {
      for (const dir of [1, -1] as const) expect(keyStep(mixParam('fader'), db, dir)).toBe(faderKeyStep(db, dir, false));
    }
  });
  it('ten steps up from 300 Hz is clearly higher', () => {
    let v = 300;
    for (let i = 0; i < 10; i++) v = keyStep(cutoff, v, 1);
    expect(v).toBeGreaterThan(500);
  });
});

describe('formatValue', () => {
  it('Hz', () => {
    expect(formatValue(cutoff, 300)).toBe('300 Hz');
    expect(formatValue(cutoff, 1200)).toBe('1.2 kHz');
    expect(formatValue(cutoff, 20000)).toBe('20 kHz');
    expect(formatValue(cutoff, 1234.5)).toBe('1.23 kHz');
    expect(formatValue(param('lfo', 'rate'), 0.25)).toBe('0.25 Hz');
    expect(formatValue(param('lfo', 'rate'), 2)).toBe('2 Hz');
  });
  it('seconds', () => {
    expect(formatValue(attack, 0.25)).toBe('250 ms');
    expect(formatValue(attack, 0.005)).toBe('5 ms');
    expect(formatValue(attack, 1.5)).toBe('1.5 s');
    expect(formatValue(attack, 10)).toBe('10 s');
    expect(formatValue(glide, 0)).toBe('off');
    expect(formatValue(glide, 0.04)).toBe('40 ms');
  });
  it('signed oct / st / ct when the range is bipolar', () => {
    expect(formatValue(octave, 1)).toBe('+1 oct');
    expect(formatValue(octave, -2)).toBe('−2 oct');
    expect(formatValue(octave, 0)).toBe('0 oct');
    expect(formatValue(param('osc', 'tune'), 0.5)).toBe('+0.5 st');
    expect(formatValue(param('osc', 'fine'), -12)).toBe('−12 ct');
    expect(formatValue(param('filter', 'cv_amt'), 3)).toBe('+3 oct');
    // unipolar ranges read as amounts, not offsets
    expect(formatValue(param('midi_in', 'bend'), 2)).toBe('2 st');
    expect(formatValue(param('osc', 'detune'), 15)).toBe('15 ct');
  });
  it('0..1 unitless params are percent; unitless integers are plain', () => {
    expect(formatValue(reso, 0.35)).toBe('35%');
    expect(formatValue(param('osc', 'pw'), 0.5)).toBe('50%');
    expect(formatValue(param('mixer', 'lvl1'), 0.8)).toBe('80%');
    expect(formatValue(param('midi_in', 'voices'), 8)).toBe('8');
  });
  it('choice params show the choice label', () => {
    expect(formatValue(param('filter', 'mode'), 2)).toBe('HP');
  });
});

describe('formatValue rounding edges', () => {
  it('switches unit when rounding reaches the next one', () => {
    expect(formatValue(cutoff, 999.7)).toBe('1 kHz');
    expect(formatValue(attack, 0.9996)).toBe('1 s');
    expect(formatValue(glide, 0.0002)).toBe('0.2 ms');
  });
});

// Mixer params (mixerCatalog) go through the same knob maths: dB readouts with
// one decimal and a real minus, the catalog's minLabel at the minimum, pan as
// L/C/R, ratio as "4:1".
describe('formatValue: mixer params', () => {
  it('dB: one decimal, signed when the range is bipolar', () => {
    expect(formatValue(mixParam('eq_low'), 3)).toBe('+3.0 dB');
    expect(formatValue(mixParam('eq_low'), -4.25)).toBe('−4.3 dB');
    expect(formatValue(mixParam('eq_low'), 0)).toBe('0.0 dB');
    expect(formatValue(mixParam('comp_threshold'), -18)).toBe('−18.0 dB');
    expect(formatValue(mixParam('comp_makeup'), 6)).toBe('6.0 dB');
    expect(formatValue(mixParam('limiter_ceiling'), -0.3)).toBe('−0.3 dB');
  });
  it('the minimum shows the minLabel ("Off", "−∞")', () => {
    expect(formatValue(mixParam('send_a'), -60)).toBe('Off');
    expect(formatValue(mixParam('send_a'), -12)).toBe('−12.0 dB');
    expect(formatValue(mixParam('eq_hp'), 20)).toBe('Off');
    expect(formatValue(mixParam('eq_hp'), 80)).toBe('80 Hz');
    expect(formatValue(mixParam('fader'), -60)).toBe('−∞');
  });
  it('pan reads L / C / R in percent', () => {
    expect(formatValue(mixParam('pan'), 0)).toBe('C');
    expect(formatValue(mixParam('pan'), -0.5)).toBe('L50');
    expect(formatValue(mixParam('pan'), 1)).toBe('R100');
    expect(formatValue(mixParam('pan'), 0.004)).toBe('C');
  });
  it('ratio, ms, s and percent', () => {
    expect(formatValue(mixParam('comp_ratio'), 4)).toBe('4:1');
    expect(formatValue(mixParam('comp_ratio'), 2.5)).toBe('2.5:1');
    expect(formatValue(mixParam('comp_attack'), 5)).toBe('5 ms');
    expect(formatValue(mixParam('rev_decay'), 2.2)).toBe('2.2 s');
    expect(formatValue(mixParam('rev_size'), 0.6)).toBe('60%');
    expect(formatValue(mixParam('delay_time'), 6)).toBe('3/16');
  });
  it('fader-taper params read like the fader (formatDb)', () => {
    for (const db of [-60, -59.95, -40, -12.34, -0.04, 0, 0.05, 3, 6]) {
      expect(formatValue(mixParam('fader'), db), `${db}`).toBe(formatDb(db));
    }
    expect(formatValue(mixParam('send_b'), -60)).toBe('Off');
    expect(formatValue(mixParam('send_b'), 3)).toBe('+3.0 dB');
  });
  it('mixer exp params map like rack ones', () => {
    const r = mixParam('comp_ratio');
    expect(toPos(r, 1)).toBe(0);
    expect(fromPos(r, 1)).toBeCloseTo(20);
  });
});

describe('parseValue (typed entry)', () => {
  it('Hz: plain, k suffix, Hz/kHz; bare numbers in the unit the readout shows', () => {
    expect(parseValue(cutoff, '440')).toBe(440);
    expect(parseValue(cutoff, '440 Hz')).toBe(440);
    expect(parseValue(cutoff, '1.2k')).toBeCloseTo(1200);
    expect(parseValue(cutoff, '1.2 kHz')).toBeCloseTo(1200);
    expect(parseValue(cutoff, '2', '1.2 kHz')).toBe(2000); // readout in kHz: "2" means 2 kHz
    expect(parseValue(cutoff, '200 Hz', '1.2 kHz')).toBe(200);
  });
  it('clamps to the range; integers round', () => {
    expect(parseValue(cutoff, '99999')).toBe(20000);
    expect(parseValue(cutoff, '1')).toBe(20);
    expect(parseValue(octave, '2.4')).toBe(2);
    expect(parseValue(octave, '-1 oct')).toBe(-1);
    expect(parseValue(octave, '−2')).toBe(-2); // real minus sign
  });
  it('seconds: ms / s suffixes, bare in the readout unit, "off"', () => {
    expect(parseValue(attack, '250 ms')).toBeCloseTo(0.25);
    expect(parseValue(attack, '1.5s')).toBeCloseTo(1.5);
    expect(parseValue(attack, '30', '12 ms')).toBeCloseTo(0.03);
    expect(parseValue(attack, '2', '1.5 s')).toBe(2);
    expect(parseValue(glide, 'off')).toBe(0);
  });
  it('0..1 params are typed as percent', () => {
    expect(parseValue(reso, '45%')).toBeCloseTo(0.45);
    expect(parseValue(reso, '45')).toBeCloseTo(0.45);
    expect(parseValue(reso, '0.3')).toBeCloseTo(0.3); // a decimal ≤ 1 is the raw value
  });
  it('mixer: dB with minus signs, -inf, pan L/C/R', () => {
    const fader = mixParam('fader');
    const pan = mixParam('pan');
    expect(parseValue(fader, '-6')).toBe(-6);
    expect(parseValue(fader, '−6.5 dB')).toBe(-6.5);
    if (fader.minLabel) expect(parseValue(fader, '-inf')).toBe(fader.min);
    expect(parseValue(pan, 'C')).toBe(0);
    expect(parseValue(pan, 'L30')).toBeCloseTo(-0.3);
    expect(parseValue(pan, 'r 100')).toBe(1);
  });
  it('a typed send value is stored as typed: no 0.1 dB snapping, no taper round trip', () => {
    expect(parseValue(mixParam('send_a'), '-12.3')).toBe(-12.3);
    expect(parseValue(mixParam('send_a'), '−12.34 dB')).toBe(-12.34);
    expect(parseValue(mixParam('send_b'), 'off')).toBe(-60);
    expect(parseValue(mixParam('send_b'), '9')).toBe(6);
  });
  it('rejects junk and wrong units', () => {
    expect(parseValue(cutoff, '')).toBeNull();
    expect(parseValue(cutoff, 'abc')).toBeNull();
    expect(parseValue(cutoff, '3 dB')).toBeNull();
    expect(parseValue(attack, '5 Hz')).toBeNull();
  });
  it('round-trips every readout it formats', () => {
    for (const d of [cutoff, glide, reso, octave, attack, mixParam('fader'), mixParam('send_a'), mixParam('pan')]) {
      for (const pos of [0, 0.13, 0.5, 0.77, 1]) {
        const v = fromPos(d, pos);
        const back = parseValue(d, formatValue(d, v), formatValue(d, v));
        expect(back, `${d.label} ${formatValue(d, v)}`).not.toBeNull();
        expect(formatValue(d, back!)).toBe(formatValue(d, v));
      }
    }
  });
});

describe('mech dial geometry', () => {
  it('sizes: lg (hero) 86, md 58, sm 46 px (spec §11)', () => {
    expect(MECH_DIAL_PX).toEqual({ lg: 86, md: 58, sm: 46 });
  });

  it('the tick ring: 11 ticks over the 270° travel, every 5th longer', () => {
    const ticks = MECH_TICKS.match(/M[^M]+/g)!;
    expect(ticks).toHaveLength(11);
    const seg = (t: string) => t.match(/-?[\d.]+/g)!.map(Number);
    const len = (t: string) => {
      const [x1, y1, x2, y2] = seg(t);
      return Math.hypot(x2 - x1, y2 - y1);
    };
    expect(len(ticks[0])).toBeCloseTo(5, 0);
    expect(len(ticks[5])).toBeCloseTo(5, 0);
    expect(len(ticks[1])).toBeCloseTo(3, 0);
    // First tick bottom-left (135°), the middle one straight up, the last bottom-right.
    const [x0, y0] = seg(ticks[0]);
    expect(x0).toBeLessThan(50);
    expect(y0).toBeGreaterThan(50);
    const [xm, ym] = seg(ticks[5]);
    expect(xm).toBeCloseTo(50, 1);
    expect(ym).toBeCloseTo(5, 1);
    const [xl, yl] = seg(ticks[10]);
    expect(xl).toBeCloseTo(100 - x0, 1);
    expect(yl).toBeCloseTo(y0, 1);
  });
});

describe('widestValue', () => {
  it('is computed once per def (memoised on the def object)', () => {
    const d = { ...attack };
    const n = widestValue(d);
    d.max = 1e9; // a def is never mutated in the app; here it shows the second call reads the cache
    expect(widestValue(d)).toBe(n);
    expect(widestValue({ ...d })).toBeGreaterThan(n); // another object: measured afresh
  });

  it('is at least the width of the min, max and default readouts', () => {
    for (const mod of ['filter', 'adsr', 'osc', 'midi_in', 'lfo']) {
      for (const pd of moduleDef(mod).params) {
        if (pd.choices.length) continue;
        const n = widestValue({ ...pd, curve: pd.curve });
        for (const v of [pd.min, pd.max, pd.default]) expect([...formatValue(pd, v)].length).toBeLessThanOrEqual(n);
      }
    }
  });

  it('covers unit changes and decimals: Attack 1 ms..10 s reads at most "10.0 s"/"999 ms"-wide', () => {
    expect(widestValue(attack)).toBeGreaterThanOrEqual('999 ms'.length);
    for (let i = 0; i <= 500; i++) expect([...formatValue(attack, fromPos(attack, i / 500))].length).toBeLessThanOrEqual(widestValue(attack));
  });

  it('holds over every catalog param and every sampled position', () => {
    let params = 0;
    for (const kind of Array.from({ length: 64 }, (_, k) => k)) {
      let def;
      try { def = moduleDef(kind); } catch { continue; }
      for (const pd of def.params) {
        if (pd.choices.length) continue;
        params++;
        const n = widestValue(pd);
        expect(n).toBeGreaterThan(0);
        // An independent, off-grid sweep (a prime step count) never beats it.
        for (let i = 0; i <= 997; i++) expect([...formatValue(pd, fromPos(pd, i / 997))].length).toBeLessThanOrEqual(n);
      }
    }
    expect(params).toBeGreaterThan(40);
  });

  it('covers every mixer param (fader law, "-inf", pan)', () => {
    for (const pd of MIX_PARAMS) {
      if (pd.choices.length) continue;
      const n = widestValue(pd);
      for (let i = 0; i <= 997; i++) expect([...formatValue(pd, fromPos(pd, i / 997))].length).toBeLessThanOrEqual(n);
    }
  });
});
