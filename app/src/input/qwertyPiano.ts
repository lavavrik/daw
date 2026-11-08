// Computer-keyboard piano: home row = white keys, row above = black keys
// (like most DAWs). KeyA is C at the current octave; default octave 4 => 60.

/** The octave at startup (KeyA = C4 = 60); Z / X move it within 0..8. The one definition. */
export const DEFAULT_OCTAVE = 4;

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

const OCTAVE_KEY = 'daw.octave';

/**
 * The remembered octave (localStorage "daw.octave"), or DEFAULT_OCTAVE when
 * missing, not an integer 0..8, or storage is unavailable/throws (private mode).
 */
export function loadOctave(): number {
  try {
    const raw = localStorage.getItem(OCTAVE_KEY);
    if (raw === null || !/^\d$/.test(raw)) return DEFAULT_OCTAVE;
    const o = Number(raw);
    return o >= 0 && o <= 8 ? o : DEFAULT_OCTAVE;
  } catch {
    return DEFAULT_OCTAVE;
  }
}

/** Remember the octave; failures (storage blocked/full) are ignored. */
export function saveOctave(o: number): void {
  try {
    localStorage.setItem(OCTAVE_KEY, String(o));
  } catch {
    /* not remembered; the session still works */
  }
}
