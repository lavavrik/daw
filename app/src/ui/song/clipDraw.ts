// Canvas drawing of the song timeline's clips (plan 20, spec §4 Playlist):
// the glossy body, the pattern preview, the audio waveform and its marks,
// the repeat notches and the hatch of a deferred or missing sample.
// Timeline.svelte decides what is visible and calls these; they read no
// component state. The look is described in Timeline.svelte's LOOK comment
// and docs/architecture/arrangement.md ("The playlist look").
import { peaksFrames, peaksLevel } from '../../audio/peaks';
import { clipGainLinear } from '../../state/audio-actions';
import type { AudioClip, Peaks } from '../../state/project.svelte';
import { THEME } from '../theme';
import { audioMarks, fileTicks, periodStarts, tickToX, xToTick } from './tlMath';
import type { PreviewMark, TlView } from './tlMath';

/**
 * Timeline canvas colours: theme tokens (ui/theme.ts mirrors theme.css). A
 * shade between tokens is a token under a veil (`veil`), never a literal.
 */
export const CANVAS = {
  lane: THEME.work, // clip rows (the playlist area)
  sep: THEME.grid, // row separators, beat lines
  bar: THEME.line,
  bar4: THEME.raised,
  ruler: THEME.panel,
  rulerText: THEME.text2,
  accent: THEME.accent,
  playhead: THEME.text, // "white"
  onColor: THEME.onColor, // clip names and previews
  /** A missing / failed sample's clip body (dark, so its light name reads at > 4.5:1) and name. */
  broken: THEME.well,
  brokenText: THEME.text,
};
/** White (lighter) or black (darker) at `a` over what is there: the shades between tokens. */
export const veil = (light: boolean, a: number) => (light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);

/**
 * A clip's body: `color` with the gloss drawn as on CSS --gloss (white 30 %
 * -> 0 at 60 % of the height), a 1 px top highlight and a 2 px darker bottom
 * edge. The caller has clipped to the rounded body.
 */
export function drawBody(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, veil(true, 0.3));
  g.addColorStop(0.6, veil(true, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = veil(true, 0.5);
  ctx.fillRect(x, y, w, 1);
  ctx.fillStyle = veil(false, 0.18);
  ctx.fillRect(x, y + h - 2, w, 2);
}

// ---- pattern previews --------------------------------------------------------------
/** No preview when one pattern period is narrower than this (px): the marks would be noise. */
export const PREVIEW_MIN_PX = 8;
/** A period up to this wide (device px) is stamped from a cached bitmap; a wider one draws its marks directly. */
export const BITMAP_MAX_PX = 2048;
/** The preview band starts this far below the clip's top (under the name). */
export const PREVIEW_TOP = 14;

/** A mark's rectangle in a period `periodPx` wide and a band `bandH` tall (px, from the period's top left). */
export function markRect(m: PreviewMark, periodPx: number, bandH: number, drum: boolean): [number, number, number, number] {
  const w = (m.t1 - m.t0) * periodPx;
  const h = m.h * bandH;
  // Steps keep a 1 px gap when there is room; a note dash is at least 1.5 px tall.
  return [m.t0 * periodPx, m.y * bandH, Math.max(1, drum && w > 3 ? w - 1 : w), Math.max(drum ? 1 : 1.5, h > 2 ? h - 0.5 : h)];
}

/**
 * One period of each pattern's marks, rendered once per pattern content
 * (the marks array's identity) and zoom, then stamped per period. `prune`
 * drops the patterns no clip uses any more.
 */
export class PreviewCache {
  private m = new Map<string, { marks: readonly PreviewMark[]; periodPx: number; bandH: number; dpr: number; cv: OffscreenCanvas }>();
  bitmap(id: string, marks: readonly PreviewMark[], drum: boolean, periodPx: number, bandH: number, dpr: number): OffscreenCanvas | null {
    const hit = this.m.get(id);
    if (hit && hit.marks === marks && hit.periodPx === periodPx && hit.bandH === bandH && hit.dpr === dpr) return hit.cv;
    const cv = hit?.cv ?? new OffscreenCanvas(1, 1);
    cv.width = Math.max(1, Math.ceil(periodPx * dpr));
    cv.height = Math.max(1, Math.ceil(bandH * dpr));
    const g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = CANVAS.onColor;
    for (const m of marks) g.fillRect(...markRect(m, periodPx, bandH, drum));
    this.m.set(id, { marks, periodPx, bandH, dpr, cv });
    return cv;
  }
  prune(keep: (id: string) => boolean) {
    for (const id of this.m.keys()) if (!keep(id)) this.m.delete(id);
  }
}

/** What drawPreview needs of a pattern clip: its pattern's id, marks and length, and the clip's time span. */
export interface PreviewClip {
  patternId: string;
  marks: readonly PreviewMark[];
  drum: boolean;
  patLen: number;
  start: number;
  len: number;
  offset: number;
}

/**
 * A pattern clip's preview, in --on-color under its name (the caller has
 * clipped to the clip's body): only the periods in view, each stamped from
 * the cache, or drawn mark by mark when a period is wider than the cap.
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D, c: PreviewClip, y: number, h: number, v: TlView, W: number, dpr: number, cache: PreviewCache,
) {
  if (!c.marks.length) return;
  const periodPx = c.patLen / v.ticksPerPx;
  if (periodPx < PREVIEW_MIN_PX) return;
  const bandY = y + PREVIEW_TOP;
  const bandH = h - PREVIEW_TOP - 3;
  const bmp = periodPx * dpr <= BITMAP_MAX_PX ? cache.bitmap(c.patternId, c.marks, c.drum, periodPx, bandH, dpr) : null;
  ctx.fillStyle = CANVAS.onColor;
  ctx.globalAlpha = 0.6;
  for (const ps of periodStarts(c.start, c.len, c.offset, c.patLen, xToTick(0, v), xToTick(W, v))) {
    const px = Math.round(tickToX(ps, v) * dpr) / dpr; // on a device pixel: crisp stamps
    if (bmp) ctx.drawImage(bmp, px, bandY, bmp.width / dpr, bmp.height / dpr);
    else {
      // A period wider than the bitmap cap (deep zoom): at most a few in view, marks drawn directly.
      for (const m of c.marks) {
        const [mx, my, mw, mh] = markRect(m, periodPx, bandH, c.drum);
        if (px + mx + mw >= 0 && px + mx <= W) ctx.fillRect(px + mx, bandY + my, mw, mh);
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** A notch + dashed line at each tick where the clip's material starts again (pattern, or a loop clip's file), in --on-color. */
export function drawRepeats(ctx: CanvasRenderingContext2D, ticks: number[], x0: number, x1: number, y: number, h: number, v: TlView) {
  ctx.strokeStyle = CANVAS.onColor;
  ctx.fillStyle = CANVAS.onColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  for (const r of ticks) {
    const rx = Math.round(tickToX(r, v)) + 0.5;
    if (rx < x0 || rx > x1) continue;
    ctx.moveTo(rx, y + 2);
    ctx.lineTo(rx, y + h);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.7;
  for (const r of ticks) {
    const rx = Math.round(tickToX(r, v)) + 0.5;
    if (rx < x0 || rx > x1) continue;
    ctx.beginPath();
    ctx.moveTo(rx - 3, y + 1);
    ctx.lineTo(rx + 3, y + 1);
    ctx.lineTo(rx, y + 5);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Diagonal stripes over [x0, x1) × [y, y + h), only those in the view `W` wide (the caller has clipped to the clip). */
export function hatch(ctx: CanvasRenderingContext2D, color: string, alpha: number, x0: number, x1: number, y: number, h: number, W: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  const xs = Math.max(x0, -h);
  const xe = Math.min(x1, W + h);
  for (let x = Math.floor(xs / 8) * 8 - h; x < xe; x += 8) {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + h, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * What is wrong with an audio clip's sample, if anything (Timeline's
 * audioState): `missing`, `failed`, `pending` (its deferred load waits for
 * Stop), or null.
 */
export type AudioState = 'missing' | 'failed' | 'pending' | null;

/**
 * An audio clip's body, in --on-color over the body colour: the waveform
 * (one min/max bar per pixel from the peaks level that matches the zoom),
 * the fade ramps, the loop notches or the end-of-file mark, and the hatch of
 * a deferred (--on-color) or missing / failed (--rec) sample. `meta`: the
 * sample's length and peaks (undefined: unknown yet); `pending`: its
 * deferred load waits for Stop. The caller has clipped to the clip's box and
 * draws the body, the name and the outline.
 */
export function drawAudio(
  ctx: CanvasRenderingContext2D, c: AudioClip, meta: { seconds: number; peaks?: Peaks | null } | undefined, tempo: number,
  x0: number, x1: number, y: number, h: number, v: TlView, W: number, pending: boolean, st: AudioState,
) {
  const seconds = meta?.seconds ?? null;
  const tps = fileTicks(1, tempo); // ticks per second
  const end = c.start + c.len;
  const top = y + 3; // full height: the name is drawn over it on a backing
  const bottom = y + h - 2;
  const mid = (top + bottom) / 2;
  const amp = (bottom - top) / 2;
  const xa = Math.max(Math.floor(x0), 0);
  const xb = Math.min(Math.ceil(x1), W);
  const gain = clipGainLinear(c.gain);
  /** The clip's own envelope (gain × fades) at song tick `t`, for scaling the picture. */
  const env = (t: number) => {
    let g = gain;
    if (c.fadeIn > 0 && t < c.start + c.fadeIn) g *= Math.max(0, (t - c.start) / c.fadeIn);
    if (c.fadeOut > 0 && t > end - c.fadeOut) g *= Math.max(0, (end - t) / c.fadeOut);
    return g;
  };

  ctx.fillStyle = CANVAS.onColor;
  if (meta?.peaks && seconds && seconds > 0) {
    const pk = meta.peaks;
    const frames = peaksFrames(pk);
    const fps = frames / seconds; // file frames per second (the rate the peaks were made at)
    const lv = peaksLevel(pk, (v.ticksPerPx / tps) * fps);
    const pairs = lv.data[0]?.length / 2 || 0;
    ctx.globalAlpha = 0.55;
    for (let px = xa; px < xb && pairs > 0; px++) {
      const ta = Math.max(c.start, xToTick(px, v));
      const tb = Math.min(end, xToTick(px + 1, v));
      if (tb <= ta) continue;
      let fa = (c.offset + (ta - c.start) / tps) * fps;
      const span = ((tb - ta) / tps) * fps;
      if (c.loop) fa %= frames;
      else if (fa >= frames) break; // the file ran out (end-of-file mark below)
      const ia = Math.floor(fa / lv.framesPerPeak);
      const ib = Math.max(ia + 1, Math.ceil((fa + span) / lv.framesPerPeak));
      let lo = 127;
      let hi = -127;
      for (let i = ia; i < ib; i++) {
        const k = c.loop ? i % pairs : i;
        if (k >= pairs) break;
        for (const ch of lv.data) {
          if (ch[2 * k] < lo) lo = ch[2 * k];
          if (ch[2 * k + 1] > hi) hi = ch[2 * k + 1];
        }
      }
      if (hi < lo) continue;
      const g = Math.min(1.5, env((ta + tb) / 2)) / 127;
      const yTop = Math.max(top - 2, mid - hi * g * amp);
      const yBot = Math.min(bottom + 1, mid - lo * g * amp);
      ctx.fillRect(px, yTop, 1, Math.max(1, yBot - yTop));
    }
    ctx.globalAlpha = 1;
  } else if (!pending && c.sampleId !== null) {
    // No peaks yet: a flat placeholder line.
    ctx.globalAlpha = 0.4;
    ctx.fillRect(xa, Math.round(mid), xb - xa, 1);
    ctx.globalAlpha = 1;
  }

  // Fade ramps: the faded-out corner darkened, the ramp drawn as a line.
  const ramp = (xs: number, ys: number, xe: number, ye: number, corner: [number, number]) => {
    ctx.fillStyle = veil(false, 0.3);
    ctx.beginPath();
    ctx.moveTo(xs, ys);
    ctx.lineTo(xe, ye);
    ctx.lineTo(corner[0], corner[1]);
    ctx.fill();
    ctx.strokeStyle = CANVAS.onColor;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xs, ys);
    ctx.lineTo(xe, ye);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  if (c.fadeIn > 0) {
    const xf = tickToX(c.start + c.fadeIn, v);
    ramp(x0, y + h, xf, y + 2, [x0, y + 2]);
  }
  if (c.fadeOut > 0) {
    const xf = tickToX(end - c.fadeOut, v);
    ramp(xf, y + 2, x1, y + h, [x1, y + 2]);
  }

  const marks = audioMarks(c, seconds, tempo);
  if (marks.repeats.length) drawRepeats(ctx, marks.repeats, x0, x1, y, h, v);
  if (marks.fileEnd !== null) {
    // The file runs out before the clip ends (a tempo change): the rest is silent, darkened.
    const xe = Math.round(tickToX(marks.fileEnd, v));
    ctx.fillStyle = veil(false, 0.45);
    ctx.fillRect(xe, y, x1 - xe, h);
    ctx.fillStyle = CANVAS.onColor;
    ctx.fillRect(xe, y, 1.5, h);
    ctx.beginPath();
    ctx.moveTo(xe, y + h);
    ctx.lineTo(xe + 4, y + h);
    ctx.lineTo(xe, y + h - 4);
    ctx.fill();
  }

  if (st === 'missing' || st === 'failed') hatch(ctx, THEME.rec, 0.7, x0, x1, y, h, W);
  else if (st === 'pending') hatch(ctx, CANVAS.onColor, 0.3, x0, x1, y, h, W);
}
