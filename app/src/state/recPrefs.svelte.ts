// Reactive mirror of the recorder's persisted settings: Count-in and the
// recording offset (state/recorder.ts loadRecSettings / saveRecSettings).
// The Recorder itself is a plain object (not reactive), and since plan 21
// two places edit the same setting: Count-in is in the pattern transport
// (PatternTransport.svelte) and in Options ▸ Count-in (MenuBar.svelte), so
// both read this one $state and write through the setters below, which
// update the recorder, the mirror and localStorage together.
import { saveRecSettings } from './recorder';
import type { Recorder } from './recorder';

export const recPrefs = $state({ countIn: false, offsetMs: 0 });

let seeded: Recorder | null = null;

/**
 * Take the values from the session's recorder (App applied the saved
 * settings to it). Once per recorder: a second component mounting with the
 * same recorder changes nothing; a new recorder (an audio restart) re-seeds.
 */
export function seedRecPrefs(r: Recorder) {
  if (seeded === r) return;
  seeded = r;
  recPrefs.countIn = r.countIn;
  recPrefs.offsetMs = r.offsetMs;
}

const save = (r: Recorder) => saveRecSettings({ countIn: r.countIn, offsetMs: r.offsetMs });

export function setCountIn(r: Recorder, on: boolean) {
  r.countIn = recPrefs.countIn = on;
  save(r);
}

/** The recorder clamps (REC_OFFSET_MIN..MAX, rounded; NaN -> 0): the mirror takes its clamped value. */
export function setRecOffset(r: Recorder, ms: number) {
  r.offsetMs = ms;
  recPrefs.offsetMs = r.offsetMs;
  save(r);
}
