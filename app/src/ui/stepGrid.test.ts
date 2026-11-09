import { describe, expect, it } from 'vitest';
import { ACCENT_MIN_VEL } from '../state/acidSteps';
import { TRACK_COLORS } from './theme';
import {
  STEP_VEL_MAX, STEP_VEL_MIN, VEL_DRAG_PX, VEL_WHEEL_IDLE_MS, VEL_WHEEL_PX, clampStepVel, dragVel, rowColor, stepCellStyle, velChip,
  velKeyStep, velStatus, velTip, wheelCarry, wheelNotch, wheelPx, wheelVelStep,
} from './stepGrid';

describe('stepCellStyle', () => {
  it('off: no fill, no accent, not playing', () => {
    expect(stepCellStyle(0, 0, false)).toEqual({ on: false, accent: false, playing: false, alt: false, fill: 0 });
  });

  it('on: the fill height is velocity / 127 of the cell', () => {
    expect(stepCellStyle(127, 0, false)).toMatchObject({ on: true, fill: 100 });
    expect(stepCellStyle(64, 0, false).fill).toBeCloseTo(50.39, 2);
    expect(stepCellStyle(100, 0, false).fill).toBeCloseTo(78.74, 2); // a click
    expect(stepCellStyle(60, 0, false).fill).toBeCloseTo(47.24, 2); // an Alt-click ghost
    expect(stepCellStyle(1, 0, false)).toMatchObject({ on: true });
    expect(stepCellStyle(1, 0, false).fill).toBeGreaterThan(0);
  });

  it('accent from the Acid rule (velocity >= 110), never on an off cell', () => {
    expect(ACCENT_MIN_VEL).toBe(110);
    expect(stepCellStyle(109, 0, false).accent).toBe(false);
    expect(stepCellStyle(110, 0, false).accent).toBe(true);
    expect(stepCellStyle(127, 0, false).accent).toBe(true);
    expect(stepCellStyle(100, 0, false).accent).toBe(false); // the default velocity reads plain
  });

  it('playing passes through, on or off', () => {
    expect(stepCellStyle(0, 3, true)).toMatchObject({ on: false, playing: true });
    expect(stepCellStyle(80, 3, true)).toMatchObject({ on: true, playing: true });
  });

  it('group shading: every other group of four is a shade lighter', () => {
    const alt = Array.from({ length: 16 }, (_, s) => stepCellStyle(0, s, false).alt);
    expect(alt).toEqual([
      false, false, false, false, true, true, true, true,
      false, false, false, false, true, true, true, true,
    ]);
    expect(stepCellStyle(0, 60, false).alt).toBe(true); // group 15 of a 64-step pattern
  });
});

describe('rowColor', () => {
  it('walks the palette from the track slot, wrapping at 8', () => {
    expect(rowColor(0, 0)).toBe(TRACK_COLORS[0]);
    expect(rowColor(0, 3)).toBe(TRACK_COLORS[3]);
    expect(rowColor(2, 0)).toBe(TRACK_COLORS[2]);
    expect(rowColor(5, 4)).toBe(TRACK_COLORS[1]);
    expect(rowColor(17, 0)).toBe(TRACK_COLORS[1]);
  });
});

describe('step velocity editing (plan 23)', () => {
  it('clampStepVel rounds into 1..127: an edit never turns a step off', () => {
    expect([STEP_VEL_MIN, STEP_VEL_MAX]).toEqual([1, 127]);
    expect(clampStepVel(0)).toBe(1);
    expect(clampStepVel(-40)).toBe(1);
    expect(clampStepVel(0.4)).toBe(1);
    expect(clampStepVel(96.6)).toBe(97);
    expect(clampStepVel(130)).toBe(127);
    expect(clampStepVel(127)).toBe(127);
  });

  it('wheelPx: pixels as they come; lines and pages count one step each; Shift reads the swapped axis', () => {
    expect(wheelPx({ deltaX: 0, deltaY: -100, deltaMode: 0, shiftKey: false })).toBe(-100);
    expect(wheelPx({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false })).toBe(3 * VEL_WHEEL_PX);
    expect(wheelPx({ deltaX: 0, deltaY: -1, deltaMode: 2, shiftKey: false })).toBe(-VEL_WHEEL_PX);
    // Shift+wheel: browsers move a mouse wheel's delta to deltaX.
    expect(wheelPx({ deltaX: -100, deltaY: 0, deltaMode: 0, shiftKey: true })).toBe(-100);
    // A horizontal swipe without Shift is the grid's own scroll, not a velocity edit.
    expect(wheelPx({ deltaX: -100, deltaY: 0, deltaMode: 0, shiftKey: false })).toBe(0);
    // ...even with the Y jitter a real trackpad swipe carries (the dominant axis decides).
    expect(wheelPx({ deltaX: -30, deltaY: 4, deltaMode: 0, shiftKey: false })).toBe(0);
    expect(wheelPx({ deltaX: 12, deltaY: -11, deltaMode: 0, shiftKey: false })).toBe(0);
    // Mostly vertical: an edit, the X jitter ignored.
    expect(wheelPx({ deltaX: 3, deltaY: -20, deltaMode: 0, shiftKey: false })).toBe(-20);
  });

  it('wheelCarry: partial travel carries on the same cell, and is dropped after 300 ms idle', () => {
    expect(VEL_WHEEL_IDLE_MS).toBe(300);
    const prev = { key: 'a', acc: -30, t: 1000 };
    expect(wheelCarry(prev, 'a', 1016)).toBe(-30);
    expect(wheelCarry(prev, 'a', 1299)).toBe(-30);
    expect(wheelCarry(prev, 'a', 1300)).toBe(0);
    expect(wheelCarry(prev, 'a', 60_000)).toBe(0);
    expect(wheelCarry(prev, 'b', 1016)).toBe(0); // another cell starts afresh
  });

  it('wheelNotch: one step per 40 px accumulated, at most one per event, up is louder', () => {
    expect(VEL_WHEEL_PX).toBe(40);
    // A mouse notch (100 px) is one step, not two; the rest is dropped.
    expect(wheelNotch(0, -100)).toEqual({ acc: 0, notch: 1 });
    expect(wheelNotch(0, 100)).toEqual({ acc: 0, notch: -1 });
    // Trackpad: small deltas add up to 40 px.
    let s = { acc: 0, notch: 0 };
    const notches: number[] = [];
    for (let i = 0; i < 10; i++) {
      s = wheelNotch(s.acc, -9);
      notches.push(s.notch);
    }
    expect(notches).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // 45 px, then 45 px again from 0
    expect(s.acc).toBe(0);
    // A reversal starts afresh: the other way's partial travel never cancels it out.
    expect(wheelNotch(-30, 20)).toEqual({ acc: 20, notch: 0 });
    expect(wheelNotch(-30, 45)).toEqual({ acc: 0, notch: -1 });
    expect(wheelNotch(10, 0)).toEqual({ acc: 10, notch: 0 });
  });

  it('wheel step: 5 per notch, 1 with Shift', () => {
    expect(wheelVelStep(false)).toBe(5);
    expect(wheelVelStep(true)).toBe(1);
  });

  it('dragVel: relative, 1 per 2 px, up is louder, clamped to 1..127', () => {
    expect(VEL_DRAG_PX).toBe(2);
    expect(dragVel(100, 40)).toBe(120); // 40 px up
    expect(dragVel(100, -40)).toBe(80);
    expect(dragVel(100, 3)).toBe(101); // 1.5 rounds half away (Math.round)
    expect(dragVel(100, 1)).toBe(100);
    expect(dragVel(100, 400)).toBe(127);
    expect(dragVel(100, -400)).toBe(1);
  });

  it('velKeyStep: Shift+arrows ±5, Alt+Shift+arrows ±1; anything else is not a velocity key', () => {
    const k = (key: string, o: { shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) =>
      velKeyStep({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...o });
    expect(k('ArrowUp', { shiftKey: true })).toBe(5);
    expect(k('ArrowDown', { shiftKey: true })).toBe(-5);
    expect(k('ArrowUp', { shiftKey: true, altKey: true })).toBe(1);
    expect(k('ArrowDown', { shiftKey: true, altKey: true })).toBe(-1);
    expect(k('ArrowUp')).toBeNull(); // plain arrows mean nothing on a cell
    expect(k('ArrowUp', { altKey: true })).toBeNull();
    expect(k('ArrowLeft', { shiftKey: true })).toBeNull();
    expect(k('ArrowUp', { shiftKey: true, metaKey: true })).toBeNull();
    expect(k('ArrowUp', { shiftKey: true, ctrlKey: true })).toBeNull();
  });

  it('chip and tooltip text', () => {
    expect(velChip(96)).toBe('vel 96');
    expect(velTip(96)).toBe('Velocity 96 — wheel or Shift-drag to change');
    expect(velStatus(96)).toBe('Velocity 96');
  });
});
