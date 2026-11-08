// The pattern transport's position readout (bottom panel header, plan 20):
// "beat / bars" of the selected track's current pattern, e.g. "1.3 / 2" =
// bar 1, beat 3 of a 2-bar pattern. Pattern mode loops every track's current
// pattern from tick 0, so the position is the heard tick modulo the pattern
// length (as the step grid's playhead). Stopped, counting in (negative
// ticks) or not finite: "– / 2".
import { BAR_TICKS } from '../audio/protocol';

const BEAT_TICKS = BAR_TICKS / 4;

/** `ticks`: the heard tick (null when the pattern transport is stopped); `len`: the pattern length in ticks. */
export function patternReadout(ticks: number | null, len: number): string {
  const bars = Math.max(1, Math.round(len / BAR_TICKS)); // patterns are whole bars (16/32/64 steps, 1..16 bars)
  if (ticks === null || !Number.isFinite(ticks) || ticks < 0 || !(len > 0)) return `– / ${bars}`;
  const pos = ticks % len;
  return `${Math.floor(pos / BAR_TICKS) + 1}.${Math.floor((pos % BAR_TICKS) / BEAT_TICKS) + 1} / ${bars}`;
}
