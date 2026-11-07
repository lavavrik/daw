// Heard-time clock: maps "now" / input-event timestamps to the transport tick
// the user actually *heard* (audio output has latency, ~250 ms on Bluetooth).
//
// Pure core (no DOM types, unit-tested) + a thin browser glue at the bottom.
//
// Chain: perf timestamp -> (getOutputTimestamp) -> audible context time
//        -> (telemetry history {ticks, frame}) -> tick.
// Telemetry: `ticks` is the playhead at the start of the next block, and
// `frame` the context frame where that applies. Count-in ticks are negative.
//
// Why a history: the heard frame lies one output latency (~250 ms on
// Bluetooth) *behind* the newest telemetry. Extrapolating backwards from the
// newest snapshot is wrong right after a jump of the playhead (loop wrap,
// seek, mode switch): it would report `loop_start - latency` while the user
// still hears the loop end. So the clock keeps the last snapshots it saw
// (sampled on every query, i.e. every rAF of a playhead) and extrapolates
// from the newest one at or before the heard frame.

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
export function heardContextTimeFallback(
  currentTime: number,
  baseLatency: number,
  outputLatency: number,
): number {
  return currentTime - (baseLatency + outputLatency);
}

// ---- telemetry history ----------------------------------------------------

/** One telemetry reading: `ticks` applies at context frame `frame`. */
interface Snapshot {
  frame: number;
  ticks: number;
  playing: boolean;
  bpm: number;
}

export interface TelemetryHistory {
  /** Store a reading (ignored if `frame` equals the newest one's). */
  record(frame: number, ticks: number, playing: boolean, bpm: number): void;
  /** Tick at context `frame` (NaN while empty); see `createTelemetryHistory`. */
  ticksAt(frame: number, sr: number): number;
  /** Snapshots held (tests). */
  size(): number;
}

/** Default ring size: 4 playheads polling at 60 Hz each keep > 1 s. */
export const HISTORY_SIZE = 256;
/**
 * A snapshot more than this many seconds older than the next one is stale
 * (nobody polled, e.g. a hidden tab: the run between them may hold jumps), so
 * the next one is used instead.
 */
export const MAX_SNAPSHOT_GAP_S = 0.1;

/**
 * Ring of the last `capacity` telemetry snapshots. `ticksAt(frame)`
 * extrapolates at constant tempo from the newest snapshot at or before
 * `frame`, so a frame before a jump reads the run it was heard in. Falls back
 * to back-extrapolating from the *next* snapshot (the pre-history behaviour)
 * when: no snapshot is that old, the chosen one was stopped (a parked
 * playhead does not advance, but the next run started somewhere between), or
 * it is stale (`MAX_SNAPSHOT_GAP_S`). A frame lower than the newest one's (a
 * new AudioContext) clears the ring.
 */
export function createTelemetryHistory(capacity = HISTORY_SIZE): TelemetryHistory {
  const ring: Snapshot[] = [];
  let head = 0; // index of the oldest once full
  const at = (i: number): Snapshot => ring[(head + i) % ring.length]; // i = 0 oldest
  return {
    record(frame, ticks, playing, bpm) {
      if (!Number.isFinite(frame) || !Number.isFinite(ticks)) return;
      const n = ring.length;
      if (n > 0) {
        const newest = at(n - 1);
        if (frame === newest.frame) return;
        if (frame < newest.frame) {
          ring.length = 0;
          head = 0;
        }
      }
      const s = { frame, ticks, playing, bpm };
      if (ring.length < capacity) ring.push(s);
      else {
        ring[head] = s;
        head = (head + 1) % capacity;
      }
    },
    ticksAt(frame, sr) {
      const n = ring.length;
      if (n === 0) return NaN;
      let i = n - 1;
      while (i >= 0 && at(i).frame > frame) i--;
      let s: Snapshot;
      if (i < 0) s = at(0);
      else if (i === n - 1) s = at(i);
      else {
        const next = at(i + 1);
        const stale = next.frame - at(i).frame > MAX_SNAPSHOT_GAP_S * sr;
        s = !at(i).playing || stale ? next : at(i);
      }
      return ticksAtContextTime(frame / sr, s, sr, s.bpm);
    },
    size: () => ring.length,
  };
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
  // Every query samples the telemetry first (the playheads query every rAF).
  const history = createTelemetryHistory();
  const sample = () => {
    const t = src.telemetry();
    history.record(t[TELEMETRY.frame], t[TELEMETRY.ticks], t[TELEMETRY.playing] === 1, getBpm());
  };
  const ticksFor = (perfMs: number, offsetMs: number): number => {
    const ts = src.outputTimestamp();
    let c: number;
    if (ts.contextTime > 0) {
      c = heardContextTime(perfMs, ts, offsetMs);
    } else {
      // Unavailable (early / headless): approximate from currentTime. The
      // fallback has no mapping for past events, so perfMs is taken as "now".
      const f = src.fallbackTimes();
      c = heardContextTimeFallback(f.currentTime, f.baseLatency, f.outputLatency) - offsetMs / 1000;
      c -= (performance.now() - perfMs) / 1000;
    }
    sample();
    return history.ticksAt(c * src.sampleRate, src.sampleRate);
  };
  return {
    heardTicks: () => ticksFor(performance.now(), 0),
    ticksForEvent: ticksFor,
  };
}
