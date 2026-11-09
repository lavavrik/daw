// Params appended to the module catalog after a frozen fixture was saved.
// An old project loads them with their catalog defaults and a save writes
// them (trackPatch writes every param), so a round-trip of a frozen fixture
// equals the fixture plus these. Used by load.test.ts and the e2e
// `v1/v2 project opens in v4` tests; extend it when the catalog grows.

/** Module id -> the appended params and their defaults. */
export const APPENDED_PARAMS: Record<string, Record<string, number>> = {
  // Plan 11.
  adsr: { delay: 0, vel_amt: 0 },
  midi_in: { glide_mode: 0 },
  // Plan 15.
  sample_player: { end: 1, loop: 0, loopStart: 0, fine: 0 },
  // Plan 16.
  noise: { color: 0 },
};

type FixtureModule = { id: string; params?: Record<string, number> };

/**
 * A fixture track as a save writes it today: synth patches gain the appended
 * params (defaults only; a value the fixture already has wins).
 */
export function withAppendedParams<T extends object>(track: T): T {
  const t = track as T & { patch?: { modules: FixtureModule[] } };
  if (!t.patch) return track;
  return {
    ...t,
    patch: {
      ...t.patch,
      modules: t.patch.modules.map((m) => (APPENDED_PARAMS[m.id] ? { ...m, params: { ...APPENDED_PARAMS[m.id], ...m.params } } : m)),
    },
  };
}

/** Mixer params appended after the fixtures were frozen (plan 29: sends C..H, Off and post-fader). */
export const APPENDED_TRACK_MIX_PARAMS: Record<string, number> = Object.fromEntries(
  ['c', 'd', 'e', 'f', 'g', 'h'].flatMap((x) => [[`send_${x}`, -60], [`send_${x}_pre`, 0]]),
);

/**
 * A fixture's `mixer` as a save writes it today: every track strip gains the
 * appended params, and (schema 7, plan 29) `reverb` / `delay` are the
 * returns 'reverb' (slot 0) and 'delay' (slot 1).
 */
export function withAppendedMixer<T extends { tracks: { params: Record<string, number> }[]; reverb?: unknown; delay?: unknown }>(mixer: T) {
  const { reverb, delay, ...rest } = mixer;
  return {
    ...rest,
    tracks: mixer.tracks.map((t) => ({ ...t, params: { ...t.params, ...APPENDED_TRACK_MIX_PARAMS } })),
    returns: [
      { id: 'reverb', kind: 'reverb', name: 'Reverb', slot: 0, params: reverb ?? {} },
      { id: 'delay', kind: 'delay', name: 'Delay', slot: 1, params: delay ?? {} },
    ],
  };
}
