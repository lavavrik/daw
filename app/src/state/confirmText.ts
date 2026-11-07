// Texts of the destructive confirmations, kept pure so they are
// tested. Patterns are shared by clips, so a confirmation that changes a pattern
// says which pattern and that every clip using it changes too; removing a
// track says that its patterns and clips go with it. None says "cannot be
// undone": since plan 7 every one of them is a single undo step (⌘Z).
import { currentPattern } from './project.svelte';
import type { PatternTrack, Track } from './project.svelte';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Clear the current pattern's `notes` notes (piano roll "Clear"). */
export function clearPatternText(track: PatternTrack, notes: number): string {
  const pat = currentPattern(track);
  const clips = track.clips.filter((c) => c.patternId === pat.id).length;
  const used =
    clips === 0 ? ''
    : clips === 1 ? ' The clip that uses it is affected too.'
    : clips === 2 ? ' Both clips that use it are affected too.'
    : ` All ${clips} clips that use it are affected too.`;
  return `Clear all ${plural(notes, 'note')} from pattern "${pat.name}" of "${track.name}"?${used}`;
}

/** Remove `track` (track header ×). */
export function removeTrackText(track: Track): string {
  if (track.kind === 'audio') {
    return track.clips.length === 0
      ? `Remove track "${track.name}"?`
      : `Remove track "${track.name}" with its ${plural(track.clips.length, 'clip')}?`;
  }
  const pats = plural(track.patterns.length, 'pattern');
  const what = track.clips.length === 0
    ? `and its ${pats}`
    : `with its ${pats} and ${plural(track.clips.length, 'clip')}`;
  return `Remove track "${track.name}" ${what}?`;
}
