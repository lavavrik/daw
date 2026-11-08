import { describe, expect, it } from 'vitest';
import { computePeaks } from '../../audio/peaks';
import { Project } from '../../state/project.svelte';
import { addAudioClip, addAudioTrack, clipGainLinear, setAudioClip, ticksPerSecond } from '../../state/audio-actions';
import {
  FINE_FPP, MIN_FPP, clipEnvelope, dragDeltaTicks, handleKeyDelta, handleX, keyView, clipFrameAt, clipMap, clipSeams, columns, fileMap, fitView, pickSource, spanText, zoomAt,
} from './waveMath';
import type { WaveSource } from './waveMath';

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 100 000 stereo frames of noise under a random loudness per 3000 frames (so edges matter). */
function signal(): Float32Array[] {
  const r = rng(12);
  return [0, 1].map(() => {
    const ch = new Float32Array(100_000);
    let amp = 0;
    for (let i = 0; i < ch.length; i++) {
      if (i % 3000 === 0) amp = r();
      ch[i] = (r() * 2 - 1) * amp;
    }
    return ch;
  });
}

function brute(ch: Float32Array, a: number, b: number): [number, number] | null {
  const i0 = Math.max(0, Math.floor(a));
  const i1 = Math.min(ch.length, Math.ceil(b));
  if (i1 <= i0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = i0; i < i1; i++) {
    lo = Math.min(lo, ch[i]);
    hi = Math.max(hi, ch[i]);
  }
  return [lo, hi];
}

describe('waveMath', () => {
  const chans = signal();
  const peaks = computePeaks(chans);
  const src: WaveSource = { frames: 100_000, rate: 48000, channels: 2, peaks, floats: chans };

  it('columns equal brute-force min/max at every zoom', () => {
    for (const fpp of [0.25, 1, 3, 255, 256, 1000, 70_000]) {
      // An unaligned start, and enough columns to run past the file's end.
      const view = { frame0: 1234.5, framesPerPx: fpp };
      const width = Math.min(400, Math.ceil((100_000 - 1234.5) / fpp) + 3);
      const cols = columns(src, view, width, fileMap(src.frames));
      const pick = pickSource(src, fpp);
      expect(cols.kind).toBe(pick.kind);
      let seen = 0;
      for (let x = 0; x < width; x++) {
        const a = view.frame0 + x * fpp;
        const b = a + fpp;
        for (let c = 0; c < 2; c++) {
          const want = brute(chans[c], a, b);
          if (want === null) {
            expect(cols.has[x], `fpp ${fpp} col ${x}: past the end`).toBe(0);
            continue;
          }
          expect(cols.has[x], `fpp ${fpp} col ${x}`).toBe(1);
          seen++;
          const lo = cols.lo[c][x];
          const hi = cols.hi[c][x];
          if (pick.kind === 'floats') {
            expect([lo, hi], `fpp ${fpp} col ${x} ch ${c}`).toEqual(want);
          } else {
            // Outward: never smaller than the truth over the column...
            expect(lo).toBeLessThanOrEqual(want[0]);
            expect(hi).toBeGreaterThanOrEqual(want[1]);
            // ...and no bigger than the pairs it touches, plus one quantisation step.
            const fpk = pick.kind === 'peaks' ? pick.framesPerPeak : 1;
            const wide = brute(chans[c], Math.floor(a / fpk) * fpk, Math.ceil(b / fpk) * fpk)!;
            expect(lo).toBeGreaterThanOrEqual(wide[0] - 1 / 127 - 1e-6);
            expect(hi).toBeLessThanOrEqual(wide[1] + 1 / 127 + 1e-6);
          }
        }
      }
      expect(seen).toBeGreaterThan(0);
    }
  });

  it('picks floats below 256 frames per pixel and the coarsest level above', () => {
    expect(FINE_FPP).toBe(256);
    expect(pickSource(src, 0.1)).toEqual({ kind: 'floats' });
    expect(pickSource(src, 255.9)).toEqual({ kind: 'floats' });
    expect(pickSource(src, 256)).toMatchObject({ kind: 'peaks', level: 0, framesPerPeak: 256 });
    expect(pickSource(src, 1023)).toMatchObject({ kind: 'peaks', level: 0 });
    expect(pickSource(src, 1024)).toMatchObject({ kind: 'peaks', level: 1, framesPerPeak: 1024 });
    expect(pickSource(src, 70_000)).toMatchObject({ kind: 'peaks', level: 4, framesPerPeak: 65536 });
    // No floats (decoding, too big, failed): level 0 stretched, never a blank.
    expect(pickSource({ ...src, floats: null }, 3)).toMatchObject({ kind: 'peaks', level: 0 });
    expect(pickSource({ ...src, floats: null, peaks: null }, 3)).toEqual({ kind: 'none' });
  });

  it('zoom keeps the frame under the pointer', () => {
    const lim = { frames: 100_000, width: 500, minFpp: MIN_FPP };
    const v = { frame0: 20_000, framesPerPx: 40 };
    const under = v.frame0 + 123 * v.framesPerPx;
    for (const f of [0.5, 0.1, 2, 1.7]) {
      const z = zoomAt(v, 123, f, lim);
      expect(z.framesPerPx).toBeCloseTo(40 * f, 9);
      expect(z.frame0 + 123 * z.framesPerPx).toBeCloseTo(under, 6);
    }
  });

  it('zoom is clamped to the file and to 16 px per sample', () => {
    expect(MIN_FPP).toBe(1 / 16);
    const lim = { frames: 100_000, width: 500, minFpp: MIN_FPP };
    expect(fitView(100_000, 500)).toEqual({ frame0: 0, framesPerPx: 200 });
    const out = zoomAt({ frame0: 50_000, framesPerPx: 40 }, 250, 1000, lim);
    expect(out).toEqual({ frame0: 0, framesPerPx: 200 });
    const inn = zoomAt({ frame0: 50_000, framesPerPx: 40 }, 250, 1e-6, lim);
    expect(inn.framesPerPx).toBe(1 / 16);
    // Never past the file's end.
    const end = zoomAt({ frame0: 99_000, framesPerPx: 10 }, 499, 1.5, lim);
    expect(end.frame0 + 500 * end.framesPerPx).toBeLessThanOrEqual(100_000 + 1e-6);
    // A file over the sample-level budget stops at 256 frames per pixel.
    const big = zoomAt({ frame0: 0, framesPerPx: 200 }, 0, 1e-6, { ...lim, minFpp: FINE_FPP });
    expect(big.framesPerPx).toBe(256);
  });

  it('clip time maps through offset and loop', () => {
    const sr = 48000;
    const tempo = 120; // 1920 ticks per second
    const tps = ticksPerSecond(tempo);
    const fileFrames = 96_000; // 2 s
    const base = { id: 'c', idx: 0, sampleId: 1, start: 0, gain: 0, fadeIn: 0, fadeOut: 0 };
    // One-shot, 0.5 s trimmed off, 3 s on the timeline: 1.5 s of audio then nothing.
    const one = { ...base, len: 3 * tps, offset: 0.5, loop: false };
    expect(clipFrameAt(one, tempo, sr, fileFrames, 0)).toBe(24_000);
    expect(clipFrameAt(one, tempo, sr, fileFrames, 1)).toBe(72_000);
    expect(clipFrameAt(one, tempo, sr, fileFrames, 1.5)).toBeNull();
    expect(clipFrameAt(one, tempo, sr, fileFrames, 2.9)).toBeNull();
    expect(clipFrameAt(one, tempo, sr, fileFrames, -0.1)).toBeNull();
    expect(clipSeams(one, tempo, sr, fileFrames)).toEqual([]);
    // Looped, 5 s: wraps at the file length; seams at 1.5 s and 3.5 s.
    const lp = { ...one, len: 5 * tps, loop: true };
    expect(clipFrameAt(lp, tempo, sr, fileFrames, 1.5)).toBe(0);
    expect(clipFrameAt(lp, tempo, sr, fileFrames, 2)).toBe(24_000);
    expect(clipFrameAt(lp, tempo, sr, fileFrames, 4)).toBe(24_000);
    expect(clipFrameAt(lp, tempo, sr, fileFrames, 5)).toBeNull(); // the clip has ended
    expect(clipSeams(lp, tempo, sr, fileFrames)).toEqual([1.5, 3.5]);
    // The offset rounds to a frame the way the engine's stage_source does.
    expect(clipFrameAt({ ...one, offset: 0.10001 / sr }, tempo, sr, fileFrames, 0)).toBe(0);
    // The columns follow the same map: a column over the seam sees both sides.
    const ramp = new Float32Array(fileFrames).map((_, i) => i / fileFrames);
    const s: WaveSource = { frames: fileFrames, rate: sr, channels: 1, peaks: null, floats: [ramp] };
    const m = clipMap(lp, tempo, sr, fileFrames);
    expect(m.end).toBe(5 * sr);
    const col = columns(s, { frame0: 1.5 * sr - 2, framesPerPx: 4 }, 1, m);
    expect(col.lo[0][0]).toBe(0);
    expect(col.hi[0][0]).toBe(Math.fround((fileFrames - 1) / fileFrames));
    // Past a one-shot's end: nothing.
    const none = columns(s, { frame0: 1.6 * sr, framesPerPx: 4 }, 1, clipMap(one, tempo, sr, fileFrames));
    expect(none.has[0]).toBe(0);
  });

  it('the envelope matches setAudioClip\'s fades and gain', () => {
    const sink = { send: () => true };
    const p = new Project();
    p.tempo = 120;
    p.sampleMeta.set(3, { seconds: 4, channels: 1, peaks: null });
    const t = addAudioTrack(p, sink)!;
    const c0 = addAudioClip(p, sink, t.id, { sampleId: 3, start: 960 })!;
    // Asks for more fade than fits: setAudioClip shortens the fade-in.
    setAudioClip(p, sink, c0.id, { gain: -6, fadeOut: 2000, fadeIn: 9000 });
    const c = t.clips[0];
    expect(c.fadeIn + c.fadeOut).toBe(c.len);
    // The engine's user_fades × the linear gain it is sent (audio_track.rs).
    const engineEnv = (x: number) => {
      let u = 1;
      if (c.fadeIn > 0 && x / c.fadeIn < 1) u *= Math.max(0, x / c.fadeIn);
      if (c.fadeOut > 0 && (c.len - x) / c.fadeOut < 1) u *= Math.max(0, (c.len - x) / c.fadeOut);
      return clipGainLinear(c.gain) * u;
    };
    const env = clipEnvelope(c);
    expect(env.gain).toBeCloseTo(clipGainLinear(-6), 12);
    for (let x = 0; x <= c.len; x += c.len / 97) {
      expect(env.at(x)).toBeCloseTo(engineEnv(x), 9);
      // The polyline drawn is the same curve.
      const pts = env.points;
      const k = pts.findIndex(([tt], i) => i + 1 < pts.length && tt <= x && x <= pts[i + 1][0]);
      const [t0, v0] = pts[k];
      const [t1, v1] = pts[k + 1];
      expect(t1 === t0 ? v1 : v0 + ((v1 - v0) * (x - t0)) / (t1 - t0)).toBeCloseTo(engineEnv(x), 9);
    }
    // No fades: flat at the gain; -inf dB: silence.
    setAudioClip(p, sink, c.id, { fadeIn: 0, fadeOut: 0, gain: 0 });
    expect(clipEnvelope(t.clips[0]).points).toEqual([[0, 1], [t.clips[0].len, 1]]);
    setAudioClip(p, sink, c.id, { gain: -60 });
    expect(clipEnvelope(t.clips[0]).at(10)).toBe(0);
  });

  it('readout names the visible span', () => {
    expect(spanText(60_000, 48000)).toBe('1.25 s');
    expect(spanText(125, 48000)).toBe('2.6 ms · 125 samples');
    expect(spanText(24_000, 48000)).toBe('500 ms · 24000 samples');
  });

  it('keys zoom at the centre, scroll and fit', () => {
    const lim = { frames: 100_000, width: 500, minFpp: MIN_FPP };
    const v = { frame0: 20_000, framesPerPx: 40 };
    const centre = v.frame0 + 250 * 40;
    const zin = keyView(v, '+', false, lim)!;
    expect(zin.framesPerPx).toBe(20);
    expect(zin.frame0 + 250 * zin.framesPerPx).toBeCloseTo(centre, 6);
    expect(keyView(v, '=', false, lim)).toEqual(zin);
    const zout = keyView(v, '-', false, lim)!;
    expect(zout.framesPerPx).toBe(80);
    expect(zout.frame0 + 250 * zout.framesPerPx).toBeCloseTo(centre, 6);
    // Arrows scroll an eighth of the view (Shift: a whole view).
    expect(keyView(v, 'ArrowRight', false, lim)).toEqual({ frame0: 20_000 + 500 * 40 / 8, framesPerPx: 40 });
    expect(keyView(v, 'ArrowLeft', true, lim)).toEqual({ frame0: 0, framesPerPx: 40 });
    expect(keyView(v, '0', false, lim)).toEqual({ frame0: 0, framesPerPx: 200 });
    expect(keyView(v, 'a', false, lim)).toBeNull();
  });
});

describe('clip-tab handle maths', () => {
  const view = { frame0: 1000, framesPerPx: 50 };
  it('handleX puts a clip tick on the view and keeps it inside 0..width', () => {
    // 2 view frames per tick: tick 600 = frame 1200 = (1200-1000)/50 = 4 px
    expect(handleX(600, view, 2, 300)).toBeCloseTo(4);
    expect(handleX(0, view, 2, 300)).toBe(0); // left of the view: pinned to the edge
    expect(handleX(1e9, view, 2, 300)).toBe(300);
  });
  it('dragDeltaTicks converts pixels to ticks through the view at the grab', () => {
    expect(dragDeltaTicks(10, 50, 2)).toBe(250);
    expect(dragDeltaTicks(-10, 50, 2)).toBe(-250);
    expect(dragDeltaTicks(10, 50, 0)).toBe(0); // degenerate: no movement, no NaN
  });
  it('handleKeyDelta: arrows step a quarter beat, Shift a beat', () => {
    expect(handleKeyDelta('ArrowRight', false)).toBe(240);
    expect(handleKeyDelta('ArrowUp', false)).toBe(240);
    expect(handleKeyDelta('ArrowLeft', false)).toBe(-240);
    expect(handleKeyDelta('ArrowDown', true)).toBe(-960);
    expect(handleKeyDelta('a', false)).toBeNull();
  });
});
