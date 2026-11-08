// Note names, shared by the piano roll (pianoroll/prMath.ts re-exports
// noteName for its callers), the knobs (rack/knobMath.ts: the Sample
// Player's Root reads as a note) and the Sample Player strip.

/** The twelve pitch classes from C, sharps only. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "C4" for 60 (C4 = middle C = 60), "A#3" for 58, "C-1" for 0. */
export const noteName = (p: number) => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
