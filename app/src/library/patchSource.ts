// Which patch-dropdown option shows a synth track's patch (Rack.svelte).
//
// Options: the starter patches by name, then the library's patches/*.json as
// "lib:<path>" (the file name is the patch name). Save patch refuses starter
// names, but a hand-made library file can still be called "Pad": the name
// alone cannot tell which one is loaded, so the Rack remembers the option
// each track's patch was last loaded or saved from (`source`) and that wins
// while it still matches. Revert reloads the same option.
import type { LibPatch } from './scan';

export const LIB = 'lib:';

/**
 * The option value for `patchName`. `source`: the value it was loaded or
 * saved from (null: unknown, e.g. it came from a project file). Falls back
 * to a library patch of that name (when nothing is recorded), then a starter, else the
 * name itself (the Rack shows it as a disabled placeholder).
 */
export function patchOptionValue(patchName: string, source: string | null, starters: string[], libPatches: LibPatch[]): string {
  if (source !== null) {
    if (source.startsWith(LIB)) {
      if (libPatches.some((x) => LIB + x.path === source && x.name === patchName)) return source;
    } else if (source === patchName && starters.includes(source)) return source;
  }
  const lp = libPatches.find((x) => x.name === patchName);
  // No recorded source: a library patch of that name wins over a same-named
  // starter, because a track saved from the library before a built-in took
  // that name (e.g. "Strings", "Sax") must not show (and revert to) the built-in.
  if (source === null && lp) return LIB + lp.path;
  if (starters.includes(patchName)) return patchName;
  return lp ? LIB + lp.path : patchName;
}
