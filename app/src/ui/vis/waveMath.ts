// Waveform-view math (plan 12 Task 4; docs/architecture/visuals.md
// *Waveforms*). Pure: no DOM, no Svelte. WaveformView.svelte draws what
// these give.
//
// Axis. A view shows a run of "view frames": file frames at the source's
// own rate (WaveSource.rate, the rate its peaks were made at), mapped to the
// file through a FrameMap. The drum-row strip shows the file as is
// (fileMap); the Clip tab shows clip time, 0..len, mapped through the clip's
// offset and, when it loops, repeating at the file length (clipMap). A view
// frame past a one-shot's end maps to nothing.
//
// Two sources of min/max per column (pickSource):
//   ≥ FINE_FPP (256) frames per pixel  the plan-9 peaks pyramid: the
//       coarsest level with at least one pair per pixel (peaksLevel); every
//       pair a column touches counts, so with the pairs' outward
//       quantisation a column is never smaller than the truth and at most
//       one pair + 1/127 bigger;
//   below 256  the sample's floats (audio/fineSamples.ts), exact: the min/
//       max of every frame the column touches. While they decode (or when
//       a file is too big for them), level 0 is stretched instead: never a
//       blank.
// The floats may come at another rate than the peaks (after an audio
// restart at a new rate the peaks are kept): each source scales view frames
// by its own length / WaveSource.frames.
//
// Zoom limits: the whole file (or clip) down to MIN_FPP = 1/16 frame per
// pixel (16 px per sample), or FINE_FPP when sample-level data cannot come.
import type { AudioClip, Peaks } from '../../state/project.svelte';
import { peaksFrames, peaksLevel } from '../../audio/peaks';
import { clipGainLinear, ticksPerSecond } from '../../state/audio-actions';

/** Below this many frames per pixel the floats are drawn (peaks have nothing finer). */
export const FINE_FPP = 256;
/** The closest zoom: 16 pixels per sample. */
export const MIN_FPP = 1 / 16;

/** What a column is drawn from (frame0 / framesPerPx are view frames, x in pixels). */
export interface View {
  frame0: number;
  framesPerPx: number;
}

export interface Limits {
  /** View frames in all (the file, or the clip's length). */
  frames: number;
  /** Pixels across. */
  width: number;
  /** The closest zoom allowed (MIN_FPP, or FINE_FPP without floats). */
  minFpp: number;
}

/** One sample's waveform data. */
export interface WaveSource {
  /** The file's length in view frames. */
  frames: number;
  /** View frames per second. */
  rate: number;
  /** 1 or 2 (one lane each). */
  channels: number;
  peaks: Peaks | null;
  /** Decoded channels (fineSamples), or null. */
  floats: Float32Array[] | null;
}

/**
 * View frames -> file frames: x maps to `offset + x` for 0 <= x < end,
 * modulo `fileFrames` when `loop`, nothing at or past `fileFrames` otherwise.
 */
export interface FrameMap {
  offset: number;
  fileFrames: number;
  loop: boolean;
  /** View frames in all. */
  end: number;
}

/** The file as is (the drum-row strip). */
export const fileMap = (frames: number): FrameMap => ({ offset: 0, fileFrames: frames, loop: false, end: frames });

/**
 * Clip time -> file frames at `rate`, as the engine plays it: the offset
 * rounds to a frame (stage_source), `len` ticks at `tempo` long.
 */
export function clipMap(c: Pick<AudioClip, 'len' | 'offset' | 'loop'>, tempo: number, rate: number, fileFrames: number): FrameMap {
  return {
    offset: Math.round(c.offset * rate),
    fileFrames,
    loop: c.loop,
    end: (c.len / ticksPerSecond(tempo)) * rate,
  };
}

/**
 * The file spans view frames [a, b) cover, written as pairs into `out`;
 * returns the count of pairs (0..2; a span longer than the file in a loop is
 * the whole file).
 */
export function fileSpans(m: FrameMap, a: number, b: number, out: number[]): number {
  a = Math.max(a, 0);
  b = Math.min(b, m.end);
  const F = m.fileFrames;
  if (!(b > a) || !(F > 0)) return 0;
  let fa = m.offset + a;
  let fb = m.offset + b;
  if (!m.loop) {
    if (fa >= F) return 0;
    out[0] = fa;
    out[1] = Math.min(fb, F);
    return 1;
  }
  if (fb - fa >= F) {
    out[0] = 0;
    out[1] = F;
    return 1;
  }
  const k = Math.floor(fa / F) * F;
  fa -= k;
  fb -= k;
  out[0] = fa;
  if (fb <= F) {
    out[1] = fb;
    return 1;
  }
  out[1] = F;
  out[2] = 0;
  out[3] = fb - F;
  return 2;
}

/** View frames in [a, b) where a loop starts the file again (none without loop). */
export function seamFrames(m: FrameMap, a: number, b: number, max = 4096): number[] {
  if (!m.loop || !(m.fileFrames > 0)) return [];
  const out: number[] = [];
  const lo = Math.max(a, 0);
  const hi = Math.min(b, m.end);
  // Seam k (k >= 1) at view frame k*F - offset.
  let k = Math.max(1, Math.ceil((lo + m.offset) / m.fileFrames));
  for (let x = k * m.fileFrames - m.offset; x < hi && out.length < max; x = ++k * m.fileFrames - m.offset) {
    if (x >= lo) out.push(x);
  }
  return out;
}

/**
 * The file frame clip second `t` plays (clip time 0..len at `tempo`), or
 * null past the clip, or past a one-shot's file end.
 */
export function clipFrameAt(
  c: Pick<AudioClip, 'len' | 'offset' | 'loop'>, tempo: number, sr: number, fileFrames: number, t: number,
): number | null {
  const m = clipMap(c, tempo, sr, fileFrames);
  const x = t * sr;
  if (!(x >= 0 && x < m.end)) return null;
  const f = m.offset + x;
  if (m.loop) return fileFrames > 0 ? f % fileFrames : null;
  return f < fileFrames ? f : null;
}

/** Clip seconds where a looping clip starts its file again (its loop seams). */
export function clipSeams(c: Pick<AudioClip, 'len' | 'offset' | 'loop'>, tempo: number, sr: number, fileFrames: number): number[] {
  const m = clipMap(c, tempo, sr, fileFrames);
  return seamFrames(m, 0, m.end).map((x) => x / sr);
}

export type SourcePick = { kind: 'floats' } | { kind: 'peaks'; level: number; framesPerPeak: number } | { kind: 'none' };

/** Which data columns at `framesPerPx` come from (see the top of this file). */
export function pickSource(src: WaveSource, framesPerPx: number): SourcePick {
  if (src.floats && (framesPerPx < FINE_FPP || !src.peaks)) return { kind: 'floats' };
  if (!src.peaks) return { kind: 'none' };
  const scale = peaksFrames(src.peaks) / (src.frames || 1);
  const lv = peaksLevel(src.peaks, framesPerPx * scale);
  return { kind: 'peaks', level: lv.level, framesPerPeak: lv.framesPerPeak };
}

export interface Columns {
  kind: SourcePick['kind'];
  /** Per channel, per column (only where `has`). */
  lo: Float32Array[];
  hi: Float32Array[];
  /** 1 where the column covers audio. */
  has: Uint8Array;
  /** 1 where a float in the column reaches |x| >= 1 (floats only: peaks clamp at 127). */
  over: Uint8Array;
}

/**
 * Min/max per pixel column: column x covers view frames
 * [frame0 + x·fpp, frame0 + (x+1)·fpp). Pass device pixels for device-pixel
 * columns.
 */
export function columns(src: WaveSource, view: View, width: number, map: FrameMap): Columns {
  const w = Math.max(0, Math.floor(width));
  const pick = pickSource(src, view.framesPerPx);
  const nch = Math.max(1, src.channels);
  const out: Columns = {
    kind: pick.kind,
    lo: Array.from({ length: nch }, () => new Float32Array(w)),
    hi: Array.from({ length: nch }, () => new Float32Array(w)),
    has: new Uint8Array(w),
    over: new Uint8Array(w),
  };
  if (pick.kind === 'none') return out;
  const spans = [0, 0, 0, 0];
  const fl = pick.kind === 'floats' ? src.floats : null;
  const fScale = fl ? (fl[0]?.length ?? 0) / (src.frames || 1) : 1;
  const pk = pick.kind === 'peaks' ? src.peaks!.levels[pick.level] : null;
  const pScale = src.peaks ? peaksFrames(src.peaks) / (src.frames || 1) : 1;
  const fpk = pick.kind === 'peaks' ? pick.framesPerPeak : 1;
  for (let x = 0; x < w; x++) {
    const a = view.frame0 + x * view.framesPerPx;
    const n = fileSpans(map, a, a + view.framesPerPx, spans);
    if (n === 0) continue;
    let any = false;
    for (let c = 0; c < nch; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = 0; s < n; s++) {
        const fa = spans[2 * s];
        const fb = spans[2 * s + 1];
        if (fl) {
          const ch = fl[Math.min(c, fl.length - 1)];
          const i0 = Math.max(0, Math.floor(fa * fScale));
          const i1 = Math.min(ch.length, Math.ceil(fb * fScale));
          for (let i = i0; i < i1; i++) {
            let v = ch[i];
            if (!(v === v)) v = 0; // NaN, as the peaks count it
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (pk) {
          const d = pk[Math.min(c, pk.length - 1)];
          const pairs = d.length / 2;
          const p0 = Math.max(0, Math.floor((fa * pScale) / fpk));
          const p1 = Math.min(pairs, Math.ceil((fb * pScale) / fpk));
          for (let i = p0; i < p1; i++) {
            const l = d[2 * i] / 127;
            const h = d[2 * i + 1] / 127;
            if (l < lo) lo = l;
            if (h > hi) hi = h;
          }
        }
      }
      if (lo === Infinity) continue;
      any = true;
      out.lo[c][x] = lo;
      out.hi[c][x] = hi;
      if (pick.kind === 'floats' && (hi >= 1 || lo <= -1)) out.over[x] = 1;
    }
    if (any) out.has[x] = 1;
  }
  return out;
}

/** The float at integer view frame `x` of channel `c` (NaN as 0), or null where nothing plays. */
export function sampleAt(src: WaveSource, map: FrameMap, x: number, c: number, tmp: number[] = [0, 0, 0, 0]): number | null {
  const fl = src.floats;
  if (!fl || fl.length === 0) return null;
  if (fileSpans(map, x, x + 1, tmp) === 0) return null;
  const ch = fl[Math.min(c, fl.length - 1)];
  const i = Math.floor(tmp[0] * (ch.length / (src.frames || 1)) + 1e-9);
  if (i < 0 || i >= ch.length) return null;
  const v = ch[i];
  return v === v ? v : 0;
}

// ---- zoom and scroll ------------------------------------------------------------

/** The widest view: everything. */
export const fitView = (frames: number, width: number, minFpp = MIN_FPP): View => ({
  frame0: 0,
  framesPerPx: Math.max(minFpp, frames / Math.max(1, width)),
});

/** `v` kept inside the limits: zoom between minFpp and the whole file, no scrolling past either end. */
export function clampView(v: View, lim: Limits): View {
  const maxF = Math.max(lim.minFpp, lim.frames / Math.max(1, lim.width));
  const fpp = Math.min(maxF, Math.max(lim.minFpp, v.framesPerPx));
  const frame0 = Math.min(Math.max(0, lim.frames - lim.width * fpp), Math.max(0, v.frame0));
  return { frame0, framesPerPx: fpp };
}

/** Zoom by `factor` (frames per pixel × factor; < 1 zooms in) keeping the frame under pixel `px`. */
export function zoomAt(v: View, px: number, factor: number, lim: Limits): View {
  const under = v.frame0 + px * v.framesPerPx;
  const fpp = clampView({ frame0: 0, framesPerPx: v.framesPerPx * factor }, lim).framesPerPx;
  return clampView({ frame0: under - px * fpp, framesPerPx: fpp }, lim);
}

/** Scroll by `dpx` pixels (positive: later). */
export const scrollBy = (v: View, dpx: number, lim: Limits): View =>
  clampView({ frame0: v.frame0 + dpx * v.framesPerPx, framesPerPx: v.framesPerPx }, lim);

/** The readout: "1.25 s" from a second up, else "2.6 ms · 125 samples". */
export function spanText(frames: number, rate: number): string {
  const s = frames / rate;
  if (s >= 1) return `${s.toFixed(2)} s`;
  const ms = s * 1000;
  return `${ms >= 100 ? ms.toFixed(0) : ms.toFixed(1)} ms · ${Math.round(frames)} samples`;
}

// ---- the clip's envelope ----------------------------------------------------------

export interface ClipEnvelope {
  /** Linear gain (clipGainLinear). */
  gain: number;
  /** Gain × fades at clip tick `t` (0..len). */
  at(t: number): number;
  /** The same curve as a polyline [clip tick, value] (the fades never overlap). */
  points: [number, number][];
}

/**
 * Gain × the fade-in / fade-out ramps, exactly as setAudioClip stores them
 * and the engine applies them (audio_track.rs user_fades: linear in time,
 * multiplied; setAudioClip keeps fadeIn + fadeOut <= len).
 */
export function clipEnvelope(c: Pick<AudioClip, 'len' | 'gain' | 'fadeIn' | 'fadeOut'>): ClipEnvelope {
  const g = clipGainLinear(c.gain);
  const { len, fadeIn: fi, fadeOut: fo } = c;
  const at = (t: number) => {
    let u = 1;
    if (fi > 0 && t / fi < 1) u *= Math.max(0, t / fi);
    if (fo > 0 && (len - t) / fo < 1) u *= Math.max(0, (len - t) / fo);
    return g * u;
  };
  const points: [number, number][] = [[0, fi > 0 ? 0 : g]];
  const add = (t: number, v: number) => {
    if (points[points.length - 1][0] !== t) points.push([t, v]);
  };
  if (fi > 0) add(fi, g);
  if (fo > 0) add(len - fo, g);
  points.push([len, fo > 0 ? 0 : g]);
  return { gain: g, at, points };
}

/**
 * The source axis for a sample's SampleMeta: its peaks' frames at the rate
 * they were made at (frames / seconds), or `fallbackRate` (the engine's)
 * before peaks exist. Floats are added by the view (fineSamples).
 */
export function waveBase(meta: { seconds: number; channels: number; peaks: Peaks | null }, fallbackRate: number): WaveSource {
  const pk = meta.peaks;
  const frames = pk ? peaksFrames(pk) : Math.round(meta.seconds * fallbackRate);
  const rate = pk && meta.seconds > 0 ? frames / meta.seconds : fallbackRate;
  return { frames, rate, channels: Math.min(2, Math.max(1, meta.channels)), peaks: pk, floats: null };
}

/** What a WaveformView overlay draws in: CSS pixels (the context is scaled by dpr). */
export interface WaveOverlay {
  view: View;
  width: number;
  height: number;
  lanes: number;
  /** CSS x of view frame `f`. */
  x(f: number): number;
}
