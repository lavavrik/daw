// Heard-time clock: maps "now" / input-event timestamps to the transport tick
// the user actually *heard* (audio output has latency, ~250 ms on Bluetooth).
//
// Pure core (no DOM types, unit-tested) + a thin browser glue at the bottom.
//
// Chain: perf timestamp -> (getOutputTimestamp) -> audible context time
//        -> (latest worklet telemetry {ticks, frame}) -> tick.
// Telemetry: `ticks` is the playhead at the start of the next block, and
// `frame` the context frame where that applies. Count-in ticks are negative.

import { TELEMETRY } from './protocol';

export const PPQ = 960;

/** Proper modulo: result in [0, m) even for negative x. */
export function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** Tick at context time `c` (s), extrapolating from telemetry at constant bpm. */
export function ticksAtContextTime(
  c: number,
  tele: { ticks: number; frame: number },
  sr: number,
  bpm: number,
): number {
  const framesPerTick = (sr * 60) / (bpm * PPQ);
  return tele.ticks + (c * sr - tele.frame) / framesPerTick;
}

/** Context time (s) that is audible at performance time `perfMs`, less a user offset. */
export function heardContextTime(
  perfMs: number,
  ts: { contextTime: number; performanceTime: number },
  offsetMs: number,
): number {
  return ts.contextTime + (perfMs - ts.performanceTime) / 1000 - offsetMs / 1000;
}

/** Heard context time when getOutputTimestamp is unusable: now minus reported latency. */
export function heardTicksFallback(
  currentTime: number,
  baseLatency: number,
  outputLatency: number,
): number {
  return currentTime - (baseLatency + outputLatency);
}

// ---- browser glue ---------------------------------------------------------

/** The slice of AudioEngine the clock needs (keeps this testable/mocked). */
export interface ClockSource {
  readonly sampleRate: number;
  telemetry(): Float64Array;
  outputTimestamp(): { contextTime: number; performanceTime: number };
  /** ctx.currentTime, baseLatency, outputLatency (seconds), for the fallback. */
  fallbackTimes(): { currentTime: number; baseLatency: number; outputLatency: number };
}

export interface AudioClock {
  /** Tick audible right now (negative during a count-in). */
  heardTicks(): number;
  /** Tick audible when an input event stamped `perfMs` happened, shifted by offsetMs. */
  ticksForEvent(perfMs: number, offsetMs: number): number;
}

export function createAudioClock(src: ClockSource, getBpm: () => number): AudioClock {
  const ticksFor = (perfMs: number, offsetMs: number): number => {
    const ts = src.outputTimestamp();
    let c: number;
    if (ts.contextTime > 0) {
      c = heardContextTime(perfMs, ts, offsetMs);
    } else {
      // Unavailable (early / headless): approximate from currentTime. The
      // fallback has no mapping for past events, so perfMs is taken as "now".
      const f = src.fallbackTimes();
      c = heardTicksFallback(f.currentTime, f.baseLatency, f.outputLatency) - offsetMs / 1000;
      c -= (performance.now() - perfMs) / 1000;
    }
    const t = src.telemetry();
    return ticksAtContextTime(c, { ticks: t[TELEMETRY.ticks], frame: t[TELEMETRY.frame] }, src.sampleRate, getBpm());
  };
  return {
    heardTicks: () => ticksFor(performance.now(), 0),
    ticksForEvent: ticksFor,
  };
}
