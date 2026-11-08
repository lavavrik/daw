// The top bar's big timer and hint line, the pure parts (unit-tested in
// bigTimer.test.ts; the components are BigTimer.svelte and TopBar.svelte).
//
// Timer: bar:beat:tick of a song tick, 4/4 at 960 PPQ (BAR_TICKS), as
// "1:01:000": the bar from 1, the beat from 1 as two digits, the tick in the
// beat as three (0..959). The seconds under it are the same tick at the
// project tempo (one tempo per song: there is no tempo automation), as
// m:ss.cc. Negative ticks (a count-in) and unreadable ones show the start.
import { PPQ } from '../audio/audioClock';
import { BAR_TICKS } from '../audio/protocol';

const safe = (t: number) => (Number.isFinite(t) && t > 0 ? Math.floor(t) : 0);

/** bar:beat:tick parts of `ticks`, as shown ("3", "02", "288"). */
export function timerParts(ticks: number): { bar: string; beat: string; tick: string } {
  const t = safe(ticks);
  const inBar = t % BAR_TICKS;
  return {
    bar: String(Math.floor(t / BAR_TICKS) + 1),
    beat: String(Math.floor(inBar / PPQ) + 1).padStart(2, '0'),
    tick: String(inBar % PPQ).padStart(3, '0'),
  };
}

/**
 * The position inside a pattern of `len` ticks while the pattern transport
 * plays: the heard tick modulo the length (Pattern mode loops the pattern
 * from tick 0, as patternReadout.ts). No length (no pattern track shown):
 * the heard tick itself. Negative (a count-in) or unreadable: 0.
 */
export function patternTicks(heard: number, len: number | null): number {
  const t = safe(heard);
  return len && len > 0 ? t % len : t;
}

/** `ticks` as time at `bpm`: "m:ss.cc". */
export function timerSeconds(ticks: number, bpm: number): string {
  const s = bpm > 0 ? (safe(ticks) / PPQ) * (60 / bpm) : 0;
  // Round to centiseconds first, so 59.996 s reads 1:00.00 and never 0:60.00.
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const rest = cs - m * 6000;
  return `${m}:${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}`;
}

/**
 * The hint line's text for a hovered element: the nearest `title`, else
 * `aria-label`, on it or an ancestor (blank ones skipped); null when none.
 */
export function hintText(el: Element | null): string | null {
  for (let e = el; e; e = e.parentElement) {
    const t = e.getAttribute('title')?.trim() || e.getAttribute('aria-label')?.trim();
    if (t) return t;
  }
  return null;
}
