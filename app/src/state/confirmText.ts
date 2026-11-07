// Texts of the destructive confirm() dialogs, kept pure so they are unit
// tested. Patterns are shared by clips, so a dialog that changes a pattern
// says which pattern and that every clip using it changes too; removing a
// track says that its patterns and clips go with it.
import { currentPattern } from './project.svelte';
import type { Track } from './project.svelte';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Clear the current pattern's `notes` notes (piano roll "Clear"). */
export function clearPatternText(track: Track, notes: number): string {
  const pat = currentPattern(track);
  const clips = track.clips.filter((c) => c.patternId === pat.id).length;
  const used =
    clips === 0 ? ''
    : clips === 1 ? ' The clip that uses it is affected too.'
    : clips === 2 ? ' Both clips that use it are affected too.'
    : ` All ${clips} clips that use it are affected too.`;
  return `Clear all ${plural(notes, 'note')} from pattern "${pat.name}" of "${track.name}"?${used} This cannot be undone.`;
}

/** Remove `track` (track header ×). */
export function removeTrackText(track: Track): string {
  const pats = plural(track.patterns.length, 'pattern');
  const what = track.clips.length === 0
    ? `and its ${pats}`
    : `with its ${pats} and ${plural(track.clips.length, 'clip')}`;
  return `Remove track "${track.name}" ${what}? This cannot be undone.`;
}
