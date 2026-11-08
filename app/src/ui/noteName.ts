// Note names, shared by the piano roll (pianoroll/prMath.ts re-exports
// noteName for its callers), the knobs (rack/knobMath.ts: the Sample
// Player's Root reads as a note), the Acid steps and the Sample Player strip.
// Every displayed note name goes through here so the "Note names" setting
// (ui/noteNames.svelte.ts: letters or solfège) applies everywhere.
import { noteNames } from './noteNames.svelte';

/** The twelve pitch classes from C, letters, sharps only. Structure (black key = length > 1), not display: use pitchClassName to show one. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** The same twelve in solfège, sharps (U+266F) as the spec's "Do♯". */
export const SOLFEGE_NAMES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** A pitch class (0..11, C = 0) in the chosen style: "C#" or "Do♯". */
export const pitchClassName = (k: number) => (noteNames.style === 'solfege' ? SOLFEGE_NAMES : NOTE_NAMES)[((k % 12) + 12) % 12];

/** "C4" / "Do4" for 60 (C4 = middle C = 60), "A#3" / "La♯3" for 58, "C-1" for 0. */
export const noteName = (p: number) => `${pitchClassName(p)}${Math.floor(p / 12) - 1}`;
