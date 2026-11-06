// Computer-keyboard piano: home row = white keys, row above = black keys
// (like most DAWs). KeyA is C at the current octave; default octave 4 => 60.

const OFFSETS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
};

/** MIDI note for a KeyboardEvent.code, or null if not a piano key / out of 0..127. */
export function keyToNote(code: string, octave: number): number | null {
  const off = OFFSETS[code];
  if (off === undefined) return null;
  const n = off + 12 * (octave + 1);
  return n >= 0 && n <= 127 ? n : null;
}
