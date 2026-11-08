// Idle-aware coalesce keys. History merges consecutive same-key entries with
// no time limit, so a caller that wants "one entry per burst of edits" must
// change the key after a pause. createSweepKeys returns `${base}:${n}`, where
// n steps when a call for the same base comes more than gapMs after that
// base's previous call (idle, measured from the last call, not the first).
// State is per base: another base has its own counter. Same idea as the MIDI
// CC sweeps (ui/midiLearn.svelte.ts: `midi:<cc>:<n>`).
export function createSweepKeys(
  gapMs = 1000, now: () => number = () => performance.now(),
): (base: string) => string {
  const last = new Map<string, { at: number; n: number }>();
  return (base) => {
    const t = now();
    const prev = last.get(base);
    const n = prev ? (t - prev.at > gapMs ? prev.n + 1 : prev.n) : 0;
    last.set(base, { at: t, n });
    return `${base}:${n}`;
  };
}
