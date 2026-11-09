<script module lang="ts">
  import type { GridKey } from './prMath';
  import { patternPosAt } from '../../state/song-actions';
  import MagnetStraight from 'phosphor-svelte/lib/MagnetStraight';
  import Eraser from 'phosphor-svelte/lib/Eraser';
  import BookOpen from 'phosphor-svelte/lib/BookOpen';
  import Icon from '../Icon.svelte';
  /** Grid size survives track switches for the session (the roll remounts per track). */
  let lastGrid: GridKey = '1/16';
</script>

<script lang="ts">
  // Piano roll for one synth track's looping note pattern (Canvas 2D, DPR aware).
  //
  // Layout (one canvas, top to bottom): bar ruler (bar numbers, beat numbers
  // when zoomed in, grid size in the corner) | note grid with the keyboard on
  // the left (pitch names on every C and on the hovered key) | velocity lane.
  // Notes past the pattern end are kept but silent: drawn hatched and dim,
  // over a darkened "past the end" area.
  //
  // Mouse:
  // - empty space: click adds a note one grid cell long (velocity 100) and
  //   keeps dragging it; Shift-drag = box select (adds to the selection);
  // - note body: drag moves (time + pitch, snapped); note end (last 6 px):
  //   drag resizes; Shift-click toggles it in the selection; Alt = no snap;
  // - keyboard: press a key to audition it (noteInput, source 'pianoroll');
  // - velocity lane: drag a stem up/down (selected stems win on a chord);
  // - wheel scrolls vertically, Shift+wheel horizontally, Cmd/Ctrl+wheel zooms.
  // Drags apply through updateNotes at most once per animation frame (the
  // latest value wins) plus the final value on pointerup. Escape or a lost
  // pointer capture mid-drag puts the original values back.
  //
  // KEYBOARD FOCUS RULE. The global shortcuts (input/shortcuts.ts) listen on
  // window in the bubbling phase. While the roll (its canvas area) has focus,
  // these keys are handled here and stopped (stopPropagation +
  // preventDefault) so they never reach the shortcuts:
  //   Delete / Backspace  delete the selection
  // (Mouse: right-click a note deletes just that note — one undo entry;
  // the canvas suppresses the browser's context menu.)
  //   Q                   quantize the selection (or every note) to the grid
  //   Cmd/Ctrl+A          select all
  //   Escape              cancel a drag, else clear the selection
  //   ← / →               nudge the selection one grid cell
  //   ↑ / ↓ (+Shift)      nudge the selection a semitone (an octave)
  // Every other key bubbles on: letters keep playing the QWERTY piano, Z/X
  // change octave, R arms recording, Space toggles the transport.
  //
  // Examples ▾ (plan 13): the house patches' example phrases
  // (state/houseExamples.ts), grouped like the patch menu, the example for
  // this track's patch first. A row's name adds it as a new pattern of this
  // track; its "+ track" adds a new synth track with that patch and the
  // example. Each is one undo step. At MAX_PATTERNS / MAX_TRACKS the buttons
  // are disabled with the same reason the pattern picker / timeline give.
  import { onDestroy, tick, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import type { AudioClock } from '../../audio/audioClock';
  import { mod } from '../../audio/audioClock';
  import type { NoteInput } from '../../input/noteInput';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { releaseSelect, selectKey } from '../selectKey';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { THEME } from '../theme';
  import { MAX_PATTERNS } from '../../audio/protocol';
  import { TRACKS_FULL_TEXT } from '../../state/actions';
  import { addExamplePattern, addExampleTrack } from '../../state/example-actions';
  import { exampleFor } from '../../state/houseExamples';
  import type { ExampleRoll } from '../../state/houseExamples';
  import { HOUSE_GROUPS } from '../../state/housePatches';
  import {
    GRID_TICKS, MAX_NOTE_LEN, PATTERNS_FULL_TEXT, addNote, clearPattern, deleteNotes, quantizeNotes, setPatternBars,
    updateNotes,
  } from '../../state/pattern-actions';
  import type { Project, SynthTrack } from '../../state/project.svelte';
  import { MAX_TRACKS, currentPattern } from '../../state/project.svelte';
  import { clearPatternText } from '../../state/confirmText';
  import {
    BAR, BEAT, KEYS_W, MIN_ROW_H, clampMove, formatPos, hitTest, initialView, isBlack, noteName, pitchToY, readout,
    snap, snapFloor, tickToX, xToTick, yToPitch, zoomAt,
  } from './prMath';
  import type { View } from './prMath';

  let { p, engine, clock, track, noteInput }: {
    p: Project;
    engine: CommandSink;
    clock: AudioClock | null;
    track: SynthTrack;
    noteInput: NoteInput | null;
  } = $props();

  const RULER_H = 20;
  const VEL_H = 60;
  /** Gap between the note grid and the velocity lane. */
  const SEP = 4;
  const AUDITION_VEL = 100;
  const SOURCE = 'pianoroll';
  /** Pixels a press must travel before it counts as a drag (a click never moves a note). */
  const DRAG_SLOP = 3;
  const LENGTHS = [1, 2, 4, 8, 16];
  const ZOOM = { minTpp: 1, maxTpp: (16 * BAR) / 200 };

  // ---- state -------------------------------------------------------------
  let canvas = $state<HTMLCanvasElement | null>(null);
  let stage = $state<HTMLDivElement | null>(null);
  let size = $state.raw({ w: 0, h: 0 });
  let dpr = $state(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  let view = $state.raw<View | null>(null);
  let gridKey = $state<GridKey>(lastGrid);
  let selected = $state.raw<Set<string>>(new Set());
  let hoverPitch = $state<number | null>(null);
  let auditionPitch = $state<number | null>(null);
  /** Box selection rectangle in canvas px. */
  let box = $state.raw<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Velocity shown in the readout while a stem is dragged. */
  let velShown = $state<number | null>(null);
  let hint = $state<string | null>(null);
  let cursor = $state('default');

  /** The pattern being edited (the track's current pattern). */
  const pat = $derived(currentPattern(track));
  const notes = $derived(pat.notes);
  const total = $derived(pat.bars * BAR);
  const grid = $derived(GRID_TICKS[gridKey]);
  const selNotes = $derived(notes.filter((n) => selected.has(n.id)));
  /** Unselected first: the selection is drawn on top, and hit-tested first (hitTest takes the last match). */
  const drawOrder = $derived([...notes.filter((n) => !selected.has(n.id)), ...selNotes]);
  const noteH = $derived(Math.max(0, size.h - RULER_H - VEL_H - SEP));
  const velTop = $derived(size.h - VEL_H);
  const lengths = $derived(LENGTHS.includes(pat.bars) ? LENGTHS : [...LENGTHS, pat.bars].sort((a, b) => a - b));

  const readoutText = $derived.by(() => {
    if (hint) return hint;
    if (velShown !== null) return `Velocity ${velShown}`;
    if (selNotes.length === 1) {
      const n = selNotes[0];
      return `${readout(n, gridKey)} · vel ${n.vel}${n.start >= total ? ' · past the end (silent)' : ''}`;
    }
    if (selNotes.length > 1) return `${selNotes.length} notes selected`;
    return `${notes.length} note${notes.length === 1 ? '' : 's'} · click to draw, Shift-drag to select`;
  });

  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  function flashHint(text: string) {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint = null), 2500);
  }

  // ---- view limits ---------------------------------------------------------
  const visibleRows = () => (view ? Math.max(1, Math.floor(noteH / view.rowH)) : 1);
  function clampView(v: View): View {
    const rows = Math.max(1, Math.floor(noteH / v.rowH));
    const lastEnd = notes.reduce((m, n) => Math.max(m, n.start + n.len), 0);
    const content = Math.max(total, lastEnd) + BAR;
    const maxScroll = Math.max(0, content - (size.w - KEYS_W) * v.ticksPerPx);
    return {
      ...v,
      scrollTick: Math.min(maxScroll, Math.max(0, v.scrollTick)),
      topPitch: Math.min(127, Math.max(Math.min(127, rows - 1), v.topPitch)),
    };
  }
  /** Whole pattern across the grid width. */
  function fitWidth() {
    if (!view || size.w <= KEYS_W) return;
    view = clampView({ ...view, ticksPerPx: total / (size.w - KEYS_W), scrollTick: 0 });
  }

  // ---- size / DPR ----------------------------------------------------------
  $effect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      size = { w: Math.floor(width), h: Math.floor(height) };
      untrack(() => {
        const h = size.h - RULER_H - VEL_H - SEP;
        if (!view && size.w > KEYS_W && h > 0) view = initialView(size.w, h, total, notes);
        else if (view) view = clampView(view);
      });
    });
    ro.observe(stage);
    return () => ro.disconnect();
  });
  $effect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const change = () => (dpr = window.devicePixelRatio || 1);
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  });

  // ---- drawing -------------------------------------------------------------
  /** Heard playhead tick inside the pattern, or null (stopped / count-in). Not reactive: the rAF loop redraws. */
  let playTick: number | null = null;

  // The canvas palette: theme tokens (ui/theme.ts mirrors theme.css), the
  // same roles as the playlist (song/clipDraw.ts). Faint shades are a token
  // drawn at a low globalAlpha (the `*A` numbers), never a new literal.
  const C = {
    bg: THEME.work, rowBlack: THEME.well, rowBlackA: 0.45, octave: THEME.line,
    // Line contrast against --work (at least the old palette's): bar lines
    // --text-dim at 65 % (~2.5:1), beat lines --line (~1.7:1), the grid a hint.
    gridLine: THEME.grid, beatLine: THEME.line, barLine: THEME.textDim, barA: 0.65, ruler: THEME.panel,
    rulerText: THEME.text2, dimText: THEME.text2, dimA: 0.8, past: THEME.lcd, pastA: 0.45, end: THEME.accent,
    keyWhite: THEME.text, keyBlack: THEME.lcd, keyText: THEME.onColor, keySeam: THEME.textDim,
    accent: THEME.accent, vel: THEME.lcd, velSep: THEME.line, playhead: THEME.text, dark: THEME.onColor,
    fontUi: THEME.fontUi, fontMono: THEME.fontMono,
  };
  /** Fill a rect in `style` at `alpha` (then back to opaque). */
  function fillA(ctx: CanvasRenderingContext2D, style: string, alpha: number, x: number, y: number, w: number, h: number) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }

  /** Reads every reactive input, so the $effect below redraws on any change. */
  function draw() {
    const cv = canvas;
    const v = view;
    if (!cv || !v || size.w <= 0 || size.h <= 0) return;
    const W = size.w;
    const H = size.h;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = RULER_H;
    const bottom = top + noteH;
    const color = track.color;
    const xEnd = tickToX(total, v);
    const t0 = xToTick(KEYS_W, v);
    const t1 = xToTick(W, v);
    const lowPitch = Math.max(0, yToPitch(noteH - 0.01, v));

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // ---- note grid (clipped to its area) ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_W, top, W - KEYS_W, noteH);
    ctx.clip();
    for (let pt = v.topPitch; pt >= lowPitch; pt--) {
      const y = top + pitchToY(pt, v);
      if (isBlack(pt)) fillA(ctx, C.rowBlack, C.rowBlackA, KEYS_W, y, W - KEYS_W, v.rowH);
      if (pt === hoverPitch || pt === auditionPitch) fillA(ctx, C.accent, 0.08, KEYS_W, y, W - KEYS_W, v.rowH);
      if (pt % 12 === 0) { // octave line under every C
        ctx.fillStyle = C.octave;
        ctx.fillRect(KEYS_W, y + v.rowH - 1, W - KEYS_W, 1);
      }
    }
    const vline = (t: number, style: string, w = 1, alpha = 1) => {
      const x = Math.round(tickToX(t, v)) + 0.5;
      fillA(ctx, style, alpha, x - w / 2, top, w, noteH);
    };
    if (grid / v.ticksPerPx >= 4) for (let t = snapFloor(t0, grid); t <= t1; t += grid) vline(t, C.gridLine);
    if (BEAT / v.ticksPerPx >= 4) for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) vline(t, C.beatLine);
    for (let t = snapFloor(t0, BAR); t <= t1; t += BAR) vline(t, C.barLine, 1, C.barA);
    if (xEnd < W) {
      fillA(ctx, C.past, C.pastA, Math.max(KEYS_W, xEnd), top, W - Math.max(KEYS_W, xEnd), noteH);
      vline(total, C.end, 2);
    }

    // notes: unselected first so the selection is drawn on top
    const order = drawOrder;
    ctx.font = `9px ${C.fontMono}`;
    ctx.textBaseline = 'middle';
    for (const n of order) {
      const x0 = tickToX(n.start, v);
      const x1 = tickToX(n.start + n.len, v);
      const y = top + pitchToY(n.pitch, v);
      if (x1 < KEYS_W || x0 > W || y + v.rowH < top || y > bottom) continue;
      const past = n.start >= total;
      const sel = selected.has(n.id);
      const w = Math.max(2, x1 - x0 - 1);
      ctx.globalAlpha = past ? 0.22 : 0.35 + (0.65 * n.vel) / 127;
      ctx.fillStyle = color;
      ctx.fillRect(x0 + 0.5, y + 1, w, v.rowH - 2);
      ctx.globalAlpha = 1;
      if (past) { // hatched: kept but silent
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 0.5, y + 1, w, v.rowH - 2);
        ctx.clip();
        ctx.strokeStyle = C.dark;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = x0 - v.rowH; k < x1; k += 5) {
          ctx.moveTo(k, y + v.rowH);
          ctx.lineTo(k + v.rowH, y);
        }
        ctx.stroke();
        ctx.restore(); // also restores globalAlpha
      }
      ctx.lineWidth = sel ? 1.5 : 1;
      ctx.strokeStyle = sel ? C.playhead : C.dark;
      ctx.globalAlpha = sel ? 1 : 0.55;
      ctx.strokeRect(x0 + 1, y + 1.5, Math.max(1, w - 1), v.rowH - 3);
      ctx.globalAlpha = 1;
      if (sel && w > 10) { // resize grip
        ctx.fillStyle = C.playhead;
        ctx.fillRect(x0 + w - 3, y + 3, 1.5, v.rowH - 6);
      }
      if (w > 22 && v.rowH >= MIN_ROW_H) { // room for "D#3" at 9 px
        ctx.fillStyle = C.dark;
        ctx.globalAlpha = 0.8;
        ctx.fillText(noteName(n.pitch), Math.max(x0, KEYS_W) + 3, y + v.rowH / 2 + 0.5);
        ctx.globalAlpha = 1;
      }
    }
    if (box) {
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      const bx = Math.min(box.x0, box.x1);
      const by = Math.min(box.y0, box.y1);
      fillA(ctx, C.accent, 0.12, bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }
    ctx.restore();

    // ---- ruler: bar numbers (beat numbers when there is room) ----
    ctx.fillStyle = C.ruler;
    ctx.fillRect(KEYS_W, 0, W - KEYS_W, RULER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_W, 0, W - KEYS_W, RULER_H);
    ctx.clip();
    if (xEnd < W) fillA(ctx, C.past, C.pastA, Math.max(KEYS_W, xEnd), 0, W, RULER_H);
    ctx.textBaseline = 'middle';
    const beatPx = BEAT / v.ticksPerPx;
    for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) {
      const x = Math.round(tickToX(t, v)) + 0.5;
      const isBar = t % BAR === 0;
      if (isBar) fillA(ctx, C.barLine, C.barA, x - 0.5, 0, 1, RULER_H);
      else fillA(ctx, C.beatLine, 1, x - 0.5, RULER_H - 6, 1, 6);
      if (isBar) {
        ctx.font = `bold 11px ${C.fontUi}`;
        ctx.fillStyle = t >= total ? C.dimText : C.rulerText;
        ctx.globalAlpha = t >= total ? C.dimA : 1;
        ctx.fillText(String(t / BAR + 1), x + 4, RULER_H / 2);
        ctx.globalAlpha = 1;
      } else if (beatPx >= 34) {
        ctx.font = `9px ${C.fontUi}`; // beat numbers: smaller, full --text-2 (>= 4.5:1 on --panel)
        ctx.fillStyle = C.rulerText;
        ctx.fillText(`${Math.floor(t / BAR) + 1}.${((t % BAR) / BEAT) + 1}`, x + 3, RULER_H / 2 + 1);
      }
    }
    if (xEnd < W && xEnd >= KEYS_W) { // pattern end marker
      ctx.fillStyle = C.end;
      ctx.fillRect(Math.round(xEnd) - 1, 0, 2, RULER_H);
      ctx.beginPath();
      ctx.moveTo(xEnd - 6, 0);
      ctx.lineTo(xEnd, 6);
      ctx.lineTo(xEnd, 0);
      ctx.fill();
    }
    ctx.restore();
    // corner: the grid size, always visible
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, KEYS_W, RULER_H);
    ctx.font = `bold 10px ${C.fontMono}`;
    ctx.fillStyle = C.accent;
    ctx.textAlign = 'center';
    ctx.fillText(gridKey, KEYS_W / 2, RULER_H / 2 + 1);
    ctx.textAlign = 'left';

    // ---- keyboard ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, KEYS_W, noteH);
    ctx.clip();
    ctx.font = `9px ${C.fontUi}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let pt = v.topPitch; pt >= lowPitch; pt--) {
      const y = top + pitchToY(pt, v);
      const black = isBlack(pt);
      ctx.fillStyle = C.keyWhite;
      ctx.fillRect(0, y, KEYS_W, v.rowH);
      if (black) {
        ctx.fillStyle = C.keyBlack;
        ctx.fillRect(0, y, KEYS_W * 0.62, v.rowH);
      }
      if (pt % 12 === 0 || pt % 12 === 5) { // B|C and E|F seams
        ctx.fillStyle = C.keySeam;
        ctx.fillRect(0, y + v.rowH - 1, KEYS_W, 1);
      }
      const hot = pt === auditionPitch || pt === hoverPitch;
      if (hot) {
        ctx.fillStyle = pt === auditionPitch ? color : C.accent;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, y, KEYS_W, v.rowH);
        ctx.globalAlpha = 1;
      }
      if (pt % 12 === 0 || hot) {
        ctx.fillStyle = hot ? C.dark : C.keyText;
        ctx.font = `${pt % 12 === 0 ? 'bold ' : ''}9px ${C.fontUi}`;
        ctx.fillText(noteName(pt), KEYS_W - 3, y + v.rowH / 2 + 0.5);
      }
    }
    ctx.restore();
    ctx.textAlign = 'left';

    // ---- velocity lane ----
    ctx.fillStyle = C.vel;
    ctx.fillRect(0, velTop, W, VEL_H);
    ctx.fillStyle = C.velSep;
    ctx.fillRect(0, velTop - SEP / 2 - 0.5, W, 1);
    ctx.font = `10px ${C.fontUi}`;
    ctx.fillStyle = THEME.textDim; // on the --lcd lane
    ctx.fillText('Vel', 6, velTop + 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEYS_W, velTop, W - KEYS_W, VEL_H);
    ctx.clip();
    for (const n of order) {
      const x = Math.round(tickToX(n.start, v)) + 0.5;
      if (x < KEYS_W - 3 || x > W + 3) continue;
      const hgt = (n.vel / 127) * (VEL_H - 8);
      const sel = selected.has(n.id);
      ctx.globalAlpha = n.start >= total ? 0.3 : sel ? 1 : 0.6;
      ctx.strokeStyle = sel ? C.playhead : color;
      ctx.fillStyle = color;
      ctx.lineWidth = sel ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, H - 2);
      ctx.lineTo(x, H - 2 - hgt);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, H - 2 - hgt, 3, 0, Math.PI * 2);
      ctx.fill();
      if (sel) ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ---- heard playhead ----
    if (playTick !== null) {
      const x = Math.round(tickToX(playTick, v)) + 0.5;
      if (x >= KEYS_W && x <= W) {
        ctx.fillStyle = C.playhead;
        ctx.fillRect(x - 0.75, 0, 1.5, velTop - SEP);
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.fill();
      }
    }
  }

  $effect(() => draw());

  // Playhead: an rAF loop only while playing; heard (latency-compensated)
  // position, nothing during a count-in.
  $effect(() => {
    if (!p.playing || !clock) return;
    const c = clock;
    let raf = 0;
    const loop = () => {
      const t = c.heardTicks();
      // Song mode: t is song time; only a clip of this pattern shows the playhead.
      playTick = !Number.isFinite(t) || t < 0 ? null
        : p.mode === 'song' ? patternPosAt(track, pat.id, t)
        : mod(t, pat.bars * BAR);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      playTick = null;
      untrack(draw);
    };
  });

  // ---- pointer ---------------------------------------------------------------
  type Orig = { id: string; pitch: number; start: number; len: number; vel: number };
  type Drag =
    | {
        kind: 'move' | 'resize'; anchor: Orig; orig: Orig[]; x0: number; y0: number; moved: boolean;
        /** Last scheduled deltas ("dt,dp" or the length delta): unchanged -> nothing is re-sent. */
        last: string;
        /** A time change was applied: from then on `start` is always sent (to come back to dt 0). */
        timeMoved: boolean;
      }
    | { kind: 'vel'; orig: Orig[]; last: number }
    | { kind: 'box'; base: Set<string> }
    | { kind: 'key' };
  let drag: Drag | null = null;
  type Change = { id: string; pitch?: number; start?: number; len?: number; vel?: number };
  let pending: Change[] | null = null;
  let raf = 0;

  function flush() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (pending) updateNotes(p, engine, track.id, pending);
    pending = null;
  }
  function schedule(c: Change[]) {
    pending = c;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; flush(); });
  }

  const snapshot = (ids: Set<string>): Orig[] =>
    notes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, pitch: n.pitch, start: n.start, len: n.len, vel: n.vel }));

  /** Canvas-local point; `ny` is in note-area coordinates (prMath). */
  function local(e: PointerEvent | WheelEvent) {
    const r = canvas!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, ny: y - RULER_H };
  }
  type Region = 'ruler' | 'keys' | 'notes' | 'vel' | 'gap';
  function region(x: number, y: number): Region {
    if (y < RULER_H) return 'ruler';
    if (y >= velTop) return 'vel';
    if (y >= RULER_H + noteH) return 'gap';
    return x < KEYS_W ? 'keys' : 'notes';
  }
  const clampPitch = (pt: number) => Math.min(127, Math.max(0, pt));
  const velFromY = (y: number) =>
    Math.min(127, Math.max(1, Math.round(((size.h - 2 - y) / (VEL_H - 8)) * 127)));

  /** Notes whose velocity stem is within 4 px of x; selected ones win when any are hit. */
  function stemsAt(x: number) {
    const v = view!;
    const hits = notes.filter((n) => Math.abs(tickToX(n.start, v) - x) <= 4);
    const sel = hits.filter((n) => selected.has(n.id));
    return new Set((sel.length ? sel : hits).map((n) => n.id));
  }

  function audition(pt: number | null, perfMs: number) {
    if (auditionPitch !== null) noteInput?.off(auditionPitch, perfMs, SOURCE);
    auditionPitch = pt;
    if (pt !== null) noteInput?.on(pt, AUDITION_VEL, perfMs, SOURCE);
  }

  /** Right-click: delete the note under the pointer (FL-style). */
  function erase(e: PointerEvent) {
    if (!view || drag) return;
    e.preventDefault();
    stage?.focus({ preventScroll: true }); // Delete etc. work after a right-click too
    const { x, y, ny } = local(e);
    if (region(x, y) !== 'notes') return;
    const hit = hitTest(drawOrder, x, ny, view);
    if (!hit) return;
    if (selected.has(hit.id)) {
      const s = new Set(selected);
      s.delete(hit.id);
      selected = s;
    }
    deleteNotes(p, engine, track.id, [hit.id]);
  }

  function down(e: PointerEvent) {
    if (e.button === 2) return erase(e);
    if (e.button !== 0 || !view || !canvas) return;
    e.preventDefault(); // no text selection
    stage?.focus({ preventScroll: true });
    const { x, y, ny } = local(e);
    const v = view;
    const reg = region(x, y);
    if (reg === 'ruler' || reg === 'gap') return;
    if (reg === 'keys') {
      drag = { kind: 'key' };
      audition(clampPitch(yToPitch(ny, v)), e.timeStamp);
    } else if (reg === 'vel') {
      const ids = stemsAt(x);
      if (!ids.size) return;
      velShown = velFromY(y);
      drag = { kind: 'vel', orig: snapshot(ids), last: velShown };
      schedule([...ids].map((id) => ({ id, vel: velShown! })));
    } else {
      const hit = hitTest(drawOrder, x, ny, v);
      if (hit) {
        if (e.shiftKey) {
          const s = new Set(selected);
          if (s.has(hit.id)) s.delete(hit.id);
          else s.add(hit.id);
          selected = s;
          return;
        }
        if (!selected.has(hit.id)) selected = new Set([hit.id]);
        const orig = snapshot(selected);
        drag = { kind: hit.part === 'end' ? 'resize' : 'move', anchor: orig.find((o) => o.id === hit.id)!, orig, x0: x, y0: ny, moved: false, last: '0,0', timeMoved: false };
      } else if (e.shiftKey) {
        drag = { kind: 'box', base: new Set(selected) };
        box = { x0: x, y0: y, x1: x, y1: y };
      } else {
        const tick = xToTick(x, v);
        const pitch = yToPitch(ny, v);
        if (pitch < 0 || pitch > 127) return;
        if (tick >= total) {
          selected = new Set();
          flashHint('Past the pattern end — raise Length to draw there');
          return;
        }
        const n = addNote(p, engine, track.id, {
          pitch, start: e.altKey ? Math.round(tick) : snapFloor(tick, grid), len: grid, vel: 100,
        });
        if (!n) {
          flashHint('Pattern is full (1024 notes)');
          return;
        }
        selected = new Set([n.id]);
        const orig = snapshot(selected);
        drag = { kind: 'move', anchor: orig[0], orig, x0: x, y0: ny, moved: false, last: '0,0', timeMoved: false };
      }
    }
    canvas.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!view) return;
    const v = view;
    const { x, y, ny } = local(e);
    if (!drag) return hover(x, y, ny);
    if (drag.kind === 'key') {
      const pt = clampPitch(yToPitch(Math.min(noteH - 1, Math.max(0, ny)), v));
      if (pt !== auditionPitch) audition(pt, e.timeStamp);
    } else if (drag.kind === 'vel') {
      velShown = velFromY(y);
      if (velShown === drag.last) return;
      drag.last = velShown;
      schedule(drag.orig.map((o) => ({ id: o.id, vel: velShown! })));
    } else if (drag.kind === 'box') {
      box = { ...box!, x1: x, y1: y };
      const b = box;
      const tA = xToTick(Math.min(b.x0, b.x1), v);
      const tB = xToTick(Math.max(b.x0, b.x1), v);
      const pHi = yToPitch(Math.min(b.y0, b.y1) - RULER_H, v);
      const pLo = yToPitch(Math.max(b.y0, b.y1) - RULER_H, v);
      const s = new Set(drag.base);
      for (const n of notes) {
        if (n.pitch >= pLo && n.pitch <= pHi && n.start < tB && n.start + n.len > tA) s.add(n.id);
      }
      selected = s;
    } else {
      const dx = x - drag.x0;
      const dy = ny - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      const dtRaw = dx * v.ticksPerPx;
      const a = drag.anchor;
      if (drag.kind === 'move') {
        const dt = e.altKey ? Math.round(dtRaw) : snap(a.start + dtRaw, grid) - a.start;
        const dp = yToPitch(ny, v) - yToPitch(drag.y0, v);
        const c = clampMove(drag.orig, dt, dp, total);
        const k = `${c.dt},${c.dp}`;
        if (k === drag.last) return;
        drag.last = k;
        // Pitch-only so far: leave `start` out (a past-the-end note keeps its place).
        if (c.dt) drag.timeMoved = true;
        const withStart = drag.timeMoved;
        schedule(drag.orig.map((o) => ({
          id: o.id, pitch: o.pitch + c.dp, ...(withStart ? { start: o.start + c.dt } : {}),
        })));
      } else {
        const end = a.start + a.len;
        const newEnd = e.altKey ? end + dtRaw : snap(end + dtRaw, grid);
        const delta = Math.round(newEnd - end);
        const k = `${delta}`;
        if (k === drag.last) return;
        drag.last = k;
        schedule(drag.orig.map((o) => ({
          id: o.id,
          len: Math.min(MAX_NOTE_LEN, Math.max(e.altKey ? 1 : Math.min(grid, o.len), o.len + delta)),
        })));
      }
    }
  }

  function hover(x: number, y: number, ny: number) {
    const v = view!;
    const reg = region(x, y);
    hoverPitch = reg === 'keys' || reg === 'notes' ? clampPitch(yToPitch(ny, v)) : null;
    if (reg === 'keys') cursor = 'pointer';
    else if (reg === 'notes') {
      const hit = hitTest(drawOrder, x, ny, v);
      cursor = hit ? (hit.part === 'end' ? 'ew-resize' : 'move') : 'crosshair';
    } else if (reg === 'vel') cursor = stemsAt(x).size ? 'ns-resize' : 'default';
    else cursor = 'default';
  }

  function up(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    drag = null; // first: the lostpointercapture that follows must not cancel
    flush();
    if (d.kind === 'key') audition(null, e.timeStamp);
    if (d.kind === 'vel') velShown = null;
    if (d.kind === 'box') box = null;
  }

  // Cmd/Ctrl+Z or redo mid-drag cancels the drag like Escape (history/gestures.ts).
  onDestroy(registerDragCancel(() => {
    if (!drag) return false;
    cancel();
    return true;
  }));
  /** Abort the drag and put the original values back. */
  function cancel() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    if (d.kind === 'key') audition(null, performance.now());
    else if (d.kind === 'box') {
      selected = d.base;
      box = null;
    } else if (d.kind === 'vel') {
      velShown = null;
      updateNotes(p, engine, track.id, d.orig.map((o) => ({ id: o.id, vel: o.vel })));
    } else if (d.moved) {
      updateNotes(p, engine, track.id, d.orig.map((o) => ({ id: o.id, pitch: o.pitch, start: o.start, len: o.len })));
    }
  }

  // ---- wheel (non-passive, so it can stop the page scrolling / zooming) -----
  let wheelRows = 0;
  $effect(() => {
    const cv = canvas;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      if (!view) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      const dx = e.deltaX * unit;
      if (e.ctrlKey || e.metaKey) {
        view = clampView(zoomAt(view, Math.exp(dy * 0.002), Math.max(KEYS_W, local(e).x), ZOOM));
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        view = clampView({ ...view, scrollTick: view.scrollTick + (dx || dy) * view.ticksPerPx });
      } else {
        wheelRows += dy / view.rowH;
        const steps = Math.trunc(wheelRows);
        wheelRows -= steps;
        if (steps) view = clampView({ ...view, topPitch: view.topPitch - steps });
      }
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  });

  // ---- keyboard (see KEYBOARD FOCUS RULE at the top) ---------------------------
  function selectedIds() {
    return selNotes.map((n) => n.id);
  }
  function quantize() {
    quantizeNotes(p, engine, track.id, selectedIds(), grid);
  }
  function nudge(dt: number, dp: number) {
    const orig = snapshot(selected);
    const c = clampMove(orig, dt, dp, total);
    if (!c.dt && !c.dp) return;
    // Only the field that moves: a pitch nudge never touches `start`.
    updateNotes(p, engine, track.id, orig.map((o) => ({
      id: o.id, ...(c.dt ? { start: o.start + c.dt } : {}), ...(c.dp ? { pitch: o.pitch + c.dp } : {}),
    })));
  }
  function key(e: KeyboardEvent) {
    const cmd = e.metaKey || e.ctrlKey;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      take();
      if (drag) cancel();
      else selected = new Set();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !cmd && !e.altKey) {
      take();
      if (selNotes.length) {
        deleteNotes(p, engine, track.id, selectedIds());
        selected = new Set();
      }
    } else if (e.code === 'KeyQ' && !cmd && !e.altKey) {
      take();
      if (!e.repeat) quantize();
    } else if (e.code === 'KeyA' && cmd && !e.altKey) {
      take();
      releaseHeldKeys(); // the shortcuts would have, on Meta (macOS eats keyups during Cmd chords)
      selected = new Set(notes.map((n) => n.id));
    } else if (e.key.startsWith('Arrow') && !cmd && !e.altKey && selNotes.length && !drag) {
      take();
      if (e.key === 'ArrowLeft') nudge(-grid, 0);
      else if (e.key === 'ArrowRight') nudge(grid, 0);
      else if (e.key === 'ArrowUp') nudge(0, e.shiftKey ? 12 : 1);
      else if (e.key === 'ArrowDown') nudge(0, e.shiftKey ? -12 : -1);
    }
  }

  // ---- toolbar -----------------------------------------------------------------
  const refocus = () => stage?.focus({ preventScroll: true });
  function setGrid(k: GridKey) {
    gridKey = lastGrid = k;
    refocus();
  }
  function setLength(bars: number) {
    setPatternBars(p, engine, track.id, bars);
    fitWidth();
    refocus();
  }
  /**
   * The open "Clear?" question: the Clear button (the popover's anchor) and
   * the track and pattern it was asked about, captured when it opened -- a
   * confirm clears exactly that pattern, or nothing if it is no longer current.
   */
  let clearAsk = $state<{ anchor: HTMLElement; trackId: string; patternId: string } | null>(null);
  function clearAll(e: MouseEvent) {
    if (!notes.length) return;
    releaseHeldKeys();
    clearAsk = { anchor: e.currentTarget as HTMLElement, trackId: track.id, patternId: pat.id };
  }
  function clearConfirmed() {
    const a = clearAsk;
    clearAsk = null;
    if (a) clearPattern(p, engine, a.trackId, a.patternId);
    selected = new Set();
    refocus(); // the popover had focus
  }

  // ---- Examples ▾ -----------------------------------------------------------------
  let exOpen = $state(false);
  /**
   * Max height of the popover: min(60vh, the room below the button) (it
   * scrolls inside), so it never runs past a short window. The inline style
   * replaces the stylesheet's 60vh, hence both here. Re-measured on a window
   * resize while open.
   */
  let exMaxH = $state(0);
  function measureExamples() {
    if (!exBtn) return;
    const room = window.innerHeight - exBtn.getBoundingClientRect().bottom - 4 - 8;
    exMaxH = Math.max(80, Math.min(window.innerHeight * 0.6, room));
  }
  function toggleExamples() {
    if (!exOpen) measureExamples();
    exOpen = !exOpen;
  }
  let exMenu = $state<HTMLElement | null>(null);
  let exBtn = $state<HTMLElement | null>(null);
  const patternsFull = $derived(track.patterns.length >= MAX_PATTERNS);
  const tracksFull = $derived(p.tracks.length >= MAX_TRACKS);
  /** Menu sections: this patch's example on its own first, then the house groups (without it). */
  const exGroups = $derived.by(() => {
    const mine = exampleFor(track.patchName);
    const groups = HOUSE_GROUPS.map((g) => ({
      label: g.label,
      examples: g.patches
        .map((x) => exampleFor(x.name))
        .filter((e): e is ExampleRoll => !!e && e !== mine),
    })).filter((g) => g.examples.length);
    return mine ? [{ label: `This patch · ${mine.patch}`, examples: [mine] }, ...groups] : groups;
  });
  /** "Acid Line" -> "acid-line" (test ids). */
  const slug = (ex: ExampleRoll) => ex.patch.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  function pickExample(ex: ExampleRoll) {
    exOpen = false;
    if (!addExamplePattern(p, engine, track.id, ex)) return void flashHint(PATTERNS_FULL_TEXT);
    selected = new Set();
    // Frame the new pattern: its length across the width, its notes in view.
    const h = noteH;
    if (size.w > KEYS_W && h > 0) view = clampView(initialView(size.w, h, total, notes));
    refocus();
  }
  function exampleTrack(ex: ExampleRoll) {
    exOpen = false;
    // The new track is selected: this roll unmounts and one opens for it.
    if (!addExampleTrack(p, engine, ex)) flashHint(TRACKS_FULL_TEXT);
  }
  /** Up/Down move between the menu's buttons (wrapping), Home/End jump; Escape closes. */
  function exKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      exOpen = false;
      exBtn?.focus();
      return;
    }
    const items = [...(exMenu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = items.length;
    const to =
      e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowUp' ? (i <= 0 ? n - 1 : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[to].focus();
  }
  /** Focus left the menu (Tab out): close it. Focus moving to the Examples button itself is left to its click. */
  function exFocusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && (exMenu?.contains(to) || exBtn?.contains(to))) return;
    if (!to) return; // window blur / clicked a non-focusable spot: the outside-click handler decides
    exOpen = false;
  }
  $effect(() => {
    if (!exOpen) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!exMenu?.contains(t) && !exBtn?.contains(t)) exOpen = false;
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', measureExamples);
    void tick().then(() => (exMenu?.querySelector<HTMLElement>('button:not(:disabled)') ?? exMenu)?.focus());
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', measureExamples);
    };
  });

  onDestroy(() => {
    flush();
    clearTimeout(hintTimer);
    if (auditionPitch !== null) noteInput?.off(auditionPitch, performance.now(), SOURCE);
  });
</script>

<div class="roll" data-testid="pianoroll" style:--c={track.color}>
  <div class="bar">
    <label title="Grid: snap and default note length">Grid
      <select data-testid="pr-grid" value={gridKey} onkeydown={selectKey} onchange={(e) => { setGrid(e.currentTarget.value as GridKey); releaseSelect(e.currentTarget, stage); }}>
        {#each Object.keys(GRID_TICKS) as k (k)}<option value={k}>{k}</option>{/each}
      </select>
    </label>
    <label title="Pattern length in bars (notes past the end are kept, silent)">Length
      <select data-testid="pr-length" value={pat.bars} onkeydown={selectKey} onchange={(e) => { setLength(Number(e.currentTarget.value)); releaseSelect(e.currentTarget, stage); }}>
        {#each lengths as b (b)}<option value={b}>{b} {b === 1 ? 'bar' : 'bars'}</option>{/each}
      </select>
    </label>
    <button data-testid="pr-quantize" title="Snap note starts to the grid: the selection, or every note (Q)" onclick={() => { quantize(); refocus(); }}>
      <Icon icon={MagnetStraight} /> Quantize {selNotes.length ? `${selNotes.length} sel.` : 'all'}
    </button>
    <button data-testid="pr-clear" title="Delete every note in this pattern" disabled={!notes.length} onclick={clearAll}><Icon icon={Eraser} /> Clear</button>
    {#if clearAsk}
      <InlineConfirm
        message={clearPatternText(track, notes.length)}
        anchor={clearAsk.anchor}
        confirmLabel="Clear"
        oncancel={() => (clearAsk = null)}
        onconfirm={clearConfirmed}
      />
    {/if}
    <div class="exwrap">
      <button data-testid="examples-menu" bind:this={exBtn} aria-haspopup="true" aria-expanded={exOpen}
        title="Example rolls for the house patches" onclick={toggleExamples}><Icon icon={BookOpen} /> Examples</button>
      {#if exOpen}
        <!-- A plain popover (like the Rack add-menu's container, minus role=menu: its
             children are headers and rows, not only menuitems). The container takes
             focus when no button is enabled, so Escape still closes it. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="exmenu" role="group" aria-label="Example rolls" tabindex="-1" data-testid="examples-list" style:max-height="{exMaxH}px" bind:this={exMenu} onkeydown={exKey} onfocusout={exFocusOut}>
          {#if patternsFull}<p class="full">{PATTERNS_FULL_TEXT}</p>{/if}
          {#if tracksFull}<p class="full">{TRACKS_FULL_TEXT}</p>{/if}
          {#each exGroups as g (g.label)}
            <div class="gh">{g.label}</div>
            {#each g.examples as ex (ex.name)}
              <div class="exrow">
                <button data-testid={`example-${slug(ex)}`} disabled={patternsFull}
                  title={patternsFull ? PATTERNS_FULL_TEXT : `Add "${ex.name}" as a new pattern of ${track.name} (${ex.bars} ${ex.bars === 1 ? 'bar' : 'bars'})`}
                  onclick={() => pickExample(ex)}>{ex.name}</button>
                <button class="plus" data-testid={`example-track-${slug(ex)}`} disabled={tracksFull}
                  title={tracksFull ? TRACKS_FULL_TEXT : `New synth track with the ${ex.patch} patch and this example`}
                  onclick={() => exampleTrack(ex)}>+ track</button>
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
    <output class="readout" data-testid="pr-readout" class:hint={!!hint}>{readoutText}</output>
  </div>
  <!-- Focusable so the roll keys (KEYBOARD FOCUS RULE) reach it. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="stage"
    bind:this={stage}
    tabindex="0"
    role="application"
    aria-label="Piano roll for {track.name}. Click to draw, right-click or Delete removes, Q quantizes, arrows nudge."
    onkeydown={key}
  >
    <canvas
      bind:this={canvas}
      data-testid="pr-canvas"
      data-view={view ? JSON.stringify({ ...view, rulerH: RULER_H, velTop }) : ''}
      style:cursor
      onpointerdown={down}
      oncontextmenu={(e) => e.preventDefault()}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={cancel}
      onlostpointercapture={cancel}
      onpointerleave={() => { if (!drag) hoverPitch = null; }}
    ></canvas>
  </div>
</div>

<style>
  /* Tokens only (spec §2; ui-theme.md). The canvas reads the same tokens
     through theme.ts (the C palette above). Buttons are the raised recipe at
     the bar's dense size (20 px, like the skinned selects beside them). */
  .roll { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; }
  .bar { display: flex; align-items: center; gap: 10px; color: var(--text-2); flex-wrap: wrap; }
  .bar label { display: flex; align-items: center; gap: 6px; }
  .bar button {
    display: inline-flex; align-items: center; gap: 4px;
    font: 500 var(--fs-ctl)/16px var(--font-ui); padding: 2px 10px; border: 0; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); cursor: pointer;
  }
  .bar button:hover:not(:disabled) { filter: brightness(1.08); }
  .bar button:disabled { opacity: 0.45; cursor: not-allowed; }
  .bar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* flex, not block: a block around the inline-flex button adds a line-box strut (+2 px toolbar). */
  .exwrap { position: relative; display: flex; }
  /* The examples popover: a --panel card with the lift, like the Rack's add menu. */
  .exmenu {
    box-sizing: border-box; position: absolute; z-index: 10; top: calc(100% + 6px); left: 0;
    display: flex; flex-direction: column; gap: 1px; min-width: 230px; max-height: 60vh; overflow-y: auto; padding: 8px;
    background: var(--panel); border-radius: var(--r-menu); box-shadow: var(--lift);
  }
  .exmenu .gh {
    margin: 8px 0 3px; padding-bottom: 2px; border-bottom: 1px solid var(--line);
    font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
  .exmenu .gh:first-of-type { margin-top: 0; }
  .exrow { display: flex; align-items: center; gap: 4px; }
  .bar .exrow button { flex: 1; text-align: left; background: transparent; box-shadow: none; white-space: nowrap; }
  .bar .exrow button.plus { flex: none; font-size: var(--fs-lbl); color: var(--text-2); box-shadow: inset 0 0 0 1px var(--line); }
  .bar .exrow button:hover:not(:disabled), .bar .exrow button:focus-visible { background: var(--raised); color: var(--text); filter: none; outline: none; }
  .exmenu .full { margin: 0 0 4px; color: var(--accent); font-size: var(--fs-ctl); white-space: nowrap; }
  .readout {
    margin-left: auto; padding: 2px 8px; border-radius: var(--r-sm); white-space: nowrap;
    background: var(--lcd); box-shadow: var(--well-shadow); color: var(--text); font: 500 var(--fs-ctl)/16px var(--font-mono);
  }
  .readout.hint { color: var(--accent); }
  .stage { position: relative; flex: 1; min-height: 180px; border: 1px solid var(--line); border-radius: var(--r-sm); outline: none; overflow: hidden; }
  .stage:focus-visible, .stage:focus { border-color: color-mix(in srgb, var(--c) 70%, var(--line)); }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
</style>
