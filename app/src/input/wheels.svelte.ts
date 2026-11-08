// The pitch-bend and mod-wheel values the engine currently has, for the
// on-screen wheels (ui/Wheels.svelte).
//
// Single source of truth: every command the UI sends passes through
// AudioEngine.send, whose `onCommand` hook App forwards here
// (`observeCommand`). So a hardware wheel (input/midi.ts sends PITCH_BEND /
// MOD_WHEEL), a drag on the on-screen wheel and a RESET_ALL (project load)
// all update the same state, and the screen always shows what the engine
// has. The engine keeps one global bend / mod and applies it to whichever
// track is the live input (engine.rs SetInputTrack re-sends it), so these
// are global too. A new engine (audio start or restart) starts at 0, so App
// calls `resetWheels` when it wires one.
//
// UI state only, never saved; bend / mod are not edits (state/edits.ts
// NON_EDIT_OPS), so moving a wheel never touches undo.
import { Op } from '../audio/protocol';

/** bend: -1..1 (times the patch's MIDI In bend range); mod: 0..1. */
export const wheels = $state({ bend: 0, mod: 0 });

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/** AudioEngine.onCommand: mirror bend / mod / reset into `wheels`. O(1). */
export function observeCommand(op: number, a = 0) {
  if (op === Op.PITCH_BEND) wheels.bend = clamp(a, -1, 1);
  else if (op === Op.MOD_WHEEL) wheels.mod = clamp(a, 0, 1);
  else if (op === Op.RESET_ALL) resetWheels();
}

/** A fresh engine: both wheels at rest. */
export function resetWheels() {
  wheels.bend = 0;
  wheels.mod = 0;
}

/**
 * The pitch wheel's readout: the bend in semitones for a patch whose MIDI In
 * bend range is `rangeSt` (null: no MIDI In, so the raw -1..1 is shown).
 */
export function bendLabel(bend: number, rangeSt: number | null): string {
  if (rangeSt === null) return (bend >= 0 ? '+' : '') + bend.toFixed(2);
  const st = bend * rangeSt;
  if (Math.abs(st) < 0.005) return '0 st';
  return (st > 0 ? '+' : '') + st.toFixed(1) + ' st';
}

/** The mod wheel's readout, as the MIDI value 0..127 a keyboard would send. */
export const modLabel = (mod: number): string => String(Math.round(mod * 127));
