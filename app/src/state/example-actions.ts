// Example rolls (plan 13): add a house patch's example phrase
// (state/houseExamples.ts) as a pattern of an existing synth track, or as a
// new track with that patch. Built from the ordinary actions (newPattern /
// addSynthTrack, renamePattern, setPatternBars, addNote), so the engine gets
// exactly the commands a user's own edits would send, and a saved project
// holds nothing new: an example pattern is just a pattern.
//
// Each action is ONE undo entry (the outer edit(); the nested actions just
// run inside it). Both check everything that can fail BEFORE the first
// change, so a refusal (patterns or tracks full, unknown track or patch)
// returns null with no state change, no engine command and no undo entry.
import { MAX_PATTERNS } from '../audio/protocol';
import type { CommandSink } from './actions';
import { uniqueTrackName } from './actions';
import { edit } from './edits';
import type { ExampleRoll } from './houseExamples';
import { BUILTIN_PATCHES } from './patches';
import { addNote, freeName, newPattern, renamePattern, setPatternBars } from './pattern-actions';
import { MAX_TRACKS, currentPattern, synthTrack } from './project.svelte';
import type { NotePatternState, Project, SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';

/**
 * Turns `t`'s current pattern into the example: a free name based on
 * `ex.name` ("Acid Line example", then "… 2"), its length, its notes. The
 * pattern is expected to be empty (a fresh one).
 */
function fillCurrent(p: Project, sink: CommandSink, t: SynthTrack, ex: ExampleRoll): NotePatternState {
  const pat = currentPattern(t);
  renamePattern(p, sink, t.id, pat.id, freeName(t, ex.name, false));
  setPatternBars(p, sink, t.id, ex.bars); // first: addNote keeps starts inside the pattern
  for (const n of ex.notes) addNote(p, sink, t.id, n, pat.id);
  return pat;
}

/**
 * A new pattern on synth track `trackId` holding example `ex`, made
 * current. Null (nothing changed) for an unknown / non-synth track or when
 * the track already has MAX_PATTERNS patterns.
 */
export function addExamplePattern(
  p: Project, sink: CommandSink, trackId: string, ex: ExampleRoll,
): NotePatternState | null {
  return edit(p, 'Add example pattern', () => {
    const t = synthTrack(p, trackId);
    if (!t || t.patterns.length >= MAX_PATTERNS) return null;
    if (!newPattern(p, sink, t.id)) return null; // cannot happen after the check; still nothing changed
    return fillCurrent(p, sink, t, ex);
  });
}

/**
 * A new synth track named after the patch ("Sax", "Sax 2", …) with the
 * built-in patch `ex.patch` and the example as its only pattern; it becomes
 * the selected track. Null (nothing changed) when all MAX_TRACKS slots are
 * taken or `ex.patch` is not a built-in patch.
 */
export function addExampleTrack(p: Project, sink: CommandSink, ex: ExampleRoll): SynthTrack | null {
  return edit(p, 'Add example track', () => {
    const patch = BUILTIN_PATCHES.find((x) => x.name === ex.patch);
    if (!patch || p.tracks.length >= MAX_TRACKS) return null;
    const t = addSynthTrack(p, sink, uniqueTrackName(p, ex.patch), patch);
    if (!t) return null; // no free slot: addSynthTrack changed nothing
    // The fresh track's empty "Pattern 1" becomes the example (no empty pattern beside it).
    fillCurrent(p, sink, t, ex);
    return t;
  });
}
