import { describe, expect, it } from 'vitest';
import { heardContextTime, heardContextTimeFallback, mod, ticksAtContextTime } from './audioClock';

const SR = 48000;

describe('audioClock', () => {
  it('ticksAtContextTime extrapolates at tempo', () => {
    // 120 BPM = 2 beats/s = 1920 ticks/s.
    const tele = { ticks: 100, frame: 48000 };
    expect(ticksAtContextTime(2, tele, SR, 120)).toBeCloseTo(100 + 1920, 6);
    expect(ticksAtContextTime(1, tele, SR, 120)).toBeCloseTo(100, 6);
  });

  it('heard tick subtracts output latency', () => {
    const ts = { contextTime: 10, performanceTime: 5000 };
    const c = heardContextTime(5100, ts, 0);
    expect(c).toBeCloseTo(10.1, 9);
    const tele = { ticks: 1000, frame: 10.25 * SR };
    expect(ticksAtContextTime(c, tele, SR, 120)).toBeCloseTo(1000 - 0.15 * 1920, 6);
  });

  it('offset shifts earlier', () => {
    const ts = { contextTime: 10, performanceTime: 5000 };
    expect(heardContextTime(5100, ts, 50)).toBeCloseTo(10.05, 9);
    expect(heardContextTime(5100, ts, -50)).toBeCloseTo(10.15, 9);
  });

  it('fallback without getOutputTimestamp', () => {
    // currentTime 5 s, base 0.01 + output 0.25 latency -> heard 4.74 s.
    expect(heardContextTimeFallback(5, 0.01, 0.25)).toBeCloseTo(4.74, 9);
    expect(heardContextTimeFallback(5, 0.01, 0)).toBeCloseTo(4.99, 9);
  });

  it('mod is non-negative', () => {
    expect(mod(-1, 3840)).toBe(3839);
    expect(mod(3840, 3840)).toBe(0);
  });
});

// ---- telemetry history (heard tick across jumps) ---------------------------

import { createAudioClock, createTelemetryHistory } from './audioClock';
import { TELEMETRY, TELEMETRY_LEN } from './protocol';

describe('telemetry history', () => {
  // 120 BPM at 48 kHz: 25 frames per tick. Loop 3840..11520.
  const FPT = 25;

  it('extrapolates from the newest snapshot at or before the frame', () => {
    const h = createTelemetryHistory(8);
    h.record(48000, 11400, true, 120);
    h.record(52000, 3840 + 40, true, 120); // wrapped at 11520 (frame 51000)
    // Before the wrap snapshot: the pre-wrap run continues.
    expect(h.ticksAt(50000, SR)).toBeCloseTo(11480, 6);
    // At/after it: the new position.
    expect(h.ticksAt(52000, SR)).toBeCloseTo(3880, 6);
    expect(h.ticksAt(54500, SR)).toBeCloseTo(3980, 6);
    // Older than every snapshot: back-extrapolate from the oldest.
    expect(h.ticksAt(48000 - 100 * FPT, SR)).toBeCloseTo(11300, 6);
  });

  it('ring keeps the newest snapshots; duplicate frames are not stored', () => {
    const h = createTelemetryHistory(4);
    for (let i = 0; i < 10; i++) {
      h.record(1000 * i, i * 40, true, 120);
      h.record(1000 * i, i * 40, true, 120);
    }
    expect(h.size()).toBe(4);
    expect(h.ticksAt(9000, SR)).toBeCloseTo(360, 6);
    expect(h.ticksAt(6500, SR)).toBeCloseTo(240 + 20, 6);
    expect(h.ticksAt(1000, SR)).toBeCloseTo(240 - 200, 6); // oldest kept is frame 6000
  });

  it('a frame going backwards (new context) clears the history', () => {
    const h = createTelemetryHistory(8);
    h.record(100000, 5000, true, 120);
    h.record(1000, 0, true, 120);
    expect(h.size()).toBe(1);
    expect(h.ticksAt(50000, SR)).toBeCloseTo(49000 / FPT, 6);
  });

  it('a stopped snapshot never extrapolates: the next playing one is used', () => {
    const h = createTelemetryHistory(8);
    h.record(1000, 0, false, 120); // parked at 0
    h.record(100000, 7680, true, 120); // started (song position 7680) before this
    expect(h.ticksAt(99000, SR)).toBeCloseTo(7680 - 40, 6); // previous behaviour
    expect(h.ticksAt(100000 + 25, SR)).toBeCloseTo(7681, 6);
  });

  it('a long gap since the snapshot (no polling, e.g. hidden tab) uses the next one', () => {
    const h = createTelemetryHistory(8);
    h.record(0, 0, true, 120);
    h.record(SR * 5, 3840 + 50, true, 120); // 5 s later, after many wraps
    expect(h.ticksAt(SR * 5 - 250, SR)).toBeCloseTo(3840 + 40, 6);
  });

  it('heard tick across a simulated loop wrap stays pre-wrap for one latency', () => {
    // Engine: plays 11000.. at 120 BPM, wraps 11520 -> 3840. Output latency
    // 0.25 s (12000 frames, 480 ticks). The UI polls every 16 ms (768 frames).
    const tele = new Float64Array(TELEMETRY_LEN);
    tele[TELEMETRY.playing] = 1;
    let frame = 480000; // context time 10 s
    const latency = 0.25;
    const src = {
      sampleRate: SR,
      telemetry: () => tele,
      // contextTime = audible context time at performanceTime (ms).
      outputTimestamp: () => ({ contextTime: frame / SR - latency, performanceTime: 1000 }),
      fallbackTimes: () => ({ currentTime: frame / SR, baseLatency: 0, outputLatency: latency }),
    };
    const clock = createAudioClock(src, () => 120);
    const LOOP_START = 3840, LOOP_END = 11520;
    const START = 11000;
    const wrapFrame = 480000 + (LOOP_END - START) * FPT; // 493000
    const engineTicks = (f: number) => {
      const t = START + (f - 480000) / FPT;
      return t < LOOP_END ? t : LOOP_START + (t - LOOP_END);
    };
    const seen: Array<[number, number]> = [];
    for (; frame <= wrapFrame + 30000; frame += 768) {
      // Telemetry is per 128-frame block: the start of the next block.
      const f = Math.ceil(frame / 128) * 128;
      tele[TELEMETRY.frame] = f;
      tele[TELEMETRY.ticks] = engineTicks(f);
      seen.push([frame - latency * SR, clock.ticksForEvent(1000, 0)]);
    }
    for (const [heardFrame, t] of seen) {
      if (heardFrame < 480000) continue; // before the first snapshot
      const want = engineTicks(heardFrame);
      // Within one poll interval of the truth (the wrap frame is only known
      // to the poll that first saw it), never back-extrapolated from the
      // post-wrap snapshot (which reads loop_start - 480 = 3360).
      const err = Math.abs(t - want);
      const nearWrap = Math.abs(heardFrame - wrapFrame) < 768;
      expect(err < 1e-6 || (nearWrap && t >= 3840 - 1e-6 && t <= LOOP_END + 768 / FPT), `frame ${heardFrame}: ${t} vs ${want}`).toBe(true);
    }
  });
});
