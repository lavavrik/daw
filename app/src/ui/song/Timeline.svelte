<script lang="ts">
  // Song timeline (the top-centre Song pane, layout B). Replaces the plan-2
  // track list: the track headers are its left column.
  //
  // Layout: one vertical scroll container (native scrolling, so headers and
  // lanes stay aligned when many tracks exist):
  //   corner "Tracks"      | ruler canvas (sticky top): bar numbers, loop range
  //   track headers (HTML) | lanes: canvas (grid, loop shading, clips, playhead)
  //                        |        + transparent DOM overlays per lane / clip
  //   footer (sticky bottom): + Drum track, + Synth track, readout
  // Time scrolls virtually (TlView.scrollTick); the canvases are DPR aware.
  // The DOM overlays (`tl-lane-<slot>`, `clip-<slot>-<idx>`) carry testids,
  // tooltips and labels; every pointer event bubbles to the lanes element and
  // is resolved by coordinates (tlMath.hitTest), never by event target.
  //
  // Clips: drawn in the track colour with the pattern name; a notch + dashed
  // line marks every point where the pattern starts again. Clips are editable
  // in Pattern mode too; the playhead (heard, latency-compensated) and the
  // parked song position are drawn only in Song mode.
  //
  // Mouse:
  // - empty lane: click places the track's current pattern at the bar
  //   (Alt: at the exact tick), cut short at the next clip, and keeps
  //   dragging it; Shift-drag = box select (adds to the selection);
  // - clip body: click selects (Shift-click toggles), drag moves the
  //   selection in time, snapped to the beat (Alt = free). Lanes never
  //   change: ruling R4 — a pattern belongs to its track and there is no
  //   cross-track pattern copy yet, so vertical drag is ignored (a hint says so);
  // - clip edges (6 px): right = length (repeat or cut), left = start, with
  //   the offset following so the music stays put; snapped to the beat;
  // - double-click a clip: select its track and its pattern in the editor;
  // - right-click a clip: in-app menu (Make unique, Delete); Escape or a
  //   click outside closes it;
  // - ruler: click seeks (nearest beat, Alt = free); drag sets the loop range
  //   in whole bars and turns the loop on. The range stays shaded (dimmer)
  //   while the loop is off or in Pattern mode;
  // - wheel scrolls lanes vertically, Shift+wheel (or a sideways swipe, or
  //   any wheel over the ruler) scrolls time, Cmd/Ctrl+wheel zooms; the
  //   footer has a plain scrollbar for mice without a wheel;
  // - macOS Ctrl+click is a right click: it opens the menu, never places;
  // - Escape during a place-and-drag removes the clip that click just placed.
  // Drags apply at most once per animation frame (latest value wins, an
  // unchanged value is not re-sent) plus the final value on pointerup.
  // Escape or a lost pointer capture mid-drag puts the original values back.
  //
  // KEYBOARD FOCUS RULE (as in the piano roll). The global shortcuts listen
  // on window, bubbling. While the lanes have focus these keys are handled
  // here and stopped (stopPropagation + preventDefault):
  //   Delete / Backspace   delete the selected clips
  //   Cmd/Ctrl+D           duplicate them (copies go right after, selected)
  //   Cmd/Ctrl+A           select every clip
  //   Escape               cancel a drag / close the menu, else clear the selection
  //   ← / →                nudge the selection one beat (Shift: one bar)
  // Every other key bubbles on: letters keep playing the QWERTY piano, Space
  // toggles the transport, Shift+L toggles PAT/SONG.
  import { onDestroy, untrack } from 'svelte';
  import type { CommandSink } from '../../state/actions';
  import { addDrumTrack, selectTrack } from '../../state/actions';
  import { addSynthTrack } from '../../state/rack-actions';
  import { STARTER_PATCHES } from '../../state/patches';
  import type { AudioClock } from '../../audio/audioClock';
  import type { Clip, Project, Track } from '../../state/project.svelte';
  import { MAX_TRACKS, currentPattern, patternLength } from '../../state/project.svelte';
  import { patternOf, selectPattern } from '../../state/pattern-actions';
  import {
    deleteClips, duplicateClips, makeUnique, moveClips, resizeClip, seek, setLoop, addClip,
  } from '../../state/song-actions';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { MAX_SONG_TICKS } from '../../audio/protocol';
  import TrackHeaders from './TrackHeaders.svelte';
  import {
    BAR, BEAT, HEADER_W, LANE_H, MIN_CLIP_W, RULER_H, ZOOM, barLabelStep, barRange, boxSelect, clampGroupDt, hitTest,
    loopFromDrag, placeLen, repeatTicks, resizeLeft, resizeRight, seekTick, snap, snapFloor, tickToX, xToTick, yToLane,
    zoomAt,
  } from './tlMath';
  import type { ClipBox, TlView } from './tlMath';

  let { p, engine, clock }: { p: Project; engine: CommandSink; clock: AudioClock | null } = $props();

  const deepBass = STARTER_PATCHES.find((x) => x.name === 'Deep Bass') ?? STARTER_PATCHES[0];
  const tracksFull = $derived(p.tracks.length >= MAX_TRACKS);
  const FULL_TITLE = `${MAX_TRACKS} tracks is the maximum: remove one to add another`;
  /** Pixels a press must travel before it counts as a drag (a click never moves a clip). */
  const DRAG_SLOP = 3;
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  /** Bars visible when the timeline first opens. */
  const OPEN_BARS = 16;

  // ---- state -------------------------------------------------------------
  let root = $state<HTMLDivElement | null>(null);
  let lanesEl = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let rulerCv = $state<HTMLCanvasElement | null>(null);
  let width = $state(0);
  let dpr = $state(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  let view = $state.raw<TlView | null>(null);
  let selected = $state.raw<Set<string>>(new Set());
  /** Box selection rectangle in lanes px. */
  let box = $state.raw<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let menu = $state.raw<{ x: number; y: number; trackId: string; clipId: string } | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let hint = $state<string | null>(null);
  let cursor = $state('default');

  type Found = { t: Track; c: Clip; lane: number };
  const lanesH = $derived(p.tracks.length * LANE_H);
  /** Every clip by id, with its track and lane (position in the track list). */
  const byId = $derived.by(() => {
    const m = new Map<string, Found>();
    p.tracks.forEach((t, lane) => { for (const c of t.clips) m.set(c.id, { t, c, lane }); });
    return m;
  });
  /** Selected ids that still exist (a deleted clip or track drops out). */
  const sel = $derived([...selected].filter((id) => byId.has(id)));
  /** Unselected first: the selection is drawn on top and hit-tested first (hitTest takes the last match). */
  const boxes = $derived.by((): ClipBox[] => {
    const all: ClipBox[] = [];
    for (const { c, lane } of byId.values()) all.push({ id: c.id, lane, start: c.start, len: c.len });
    return [...all.filter((b) => !selected.has(b.id)), ...all.filter((b) => selected.has(b.id))];
  });

  const patLenOf = (t: Track, c: Clip) => {
    const pat = patternOf(t, c.patternId);
    return pat ? patternLength(pat) : BAR;
  };
  const patNameOf = (t: Track, c: Clip) => patternOf(t, c.patternId)?.name ?? '?';
  const uses = (t: Track, patternId: string) => t.clips.filter((c) => c.patternId === patternId).length;

  const readoutText = $derived.by(() => {
    if (hint) return hint;
    if (sel.length === 1) {
      const { t, c } = byId.get(sel[0])!;
      const reps = c.len / patLenOf(t, c);
      const times = Number.isInteger(reps) ? `×${reps}` : `×${reps.toFixed(2)}`;
      const inEditor = p.selectedTrackId === t.id && t.currentPatternId === c.patternId;
      return `${t.name} · ${patNameOf(t, c)} · ${barRange(c.start, c.len)} · ${times}${inEditor ? '' : ' · double-click to edit'}`;
    }
    if (sel.length > 1) return `${sel.length} clips selected`;
    if (p.mode === 'pattern' && byId.size) return 'Pattern mode: tracks loop their pattern — SONG (Shift+L) plays the timeline';
    return 'Click a lane to place its pattern · drag the ruler to loop';
  });

  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  function flashHint(text: string) {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint = null), 2500);
  }

  // ---- view ----------------------------------------------------------------
  function clampView(v: TlView): TlView {
    const ticksPerPx = Math.min(ZOOM.maxTpp, Math.max(ZOOM.minTpp, v.ticksPerPx));
    const maxScroll = Math.max(0, MAX_SONG_TICKS - width * ticksPerPx);
    return { ...v, ticksPerPx, scrollTick: Math.min(maxScroll, Math.max(0, v.scrollTick)) };
  }

  $effect(() => {
    if (!lanesEl) return;
    const ro = new ResizeObserver(([entry]) => {
      width = Math.floor(entry.contentRect.width);
      untrack(() => {
        if (!view && width > 0) view = clampView({ ticksPerPx: (OPEN_BARS * BAR) / width, scrollTick: 0, laneH: LANE_H });
        else if (view) view = clampView(view);
      });
    });
    ro.observe(lanesEl);
    return () => ro.disconnect();
  });
  $effect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const change = () => (dpr = window.devicePixelRatio || 1);
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  });

  // ---- drawing -------------------------------------------------------------
  /** Heard song tick while playing in Song mode, else null. Not reactive: the rAF loop redraws. */
  let playTick: number | null = null;

  const C = {
    bg: '#17181c', laneA: '#1c1d22', laneB: '#1f2026', laneSel: '#262935', beat: '#25272e', bar: '#353842',
    bar4: '#4a4e5b', ruler: '#202227', rulerText: '#c9cbd3', dimText: '#7d808c', accent: '#f0a23a', playhead: '#ffffff',
  };
  /** The loop range counts (bright) only while on and in Song mode; otherwise it is shown dimmed. */
  const loopLive = () => p.loop.on && p.mode === 'song';

  function sizeCanvas(cv: HTMLCanvasElement, w: number, h: number) {
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /** Song-mode marker: the heard playhead while playing, else the parked song position (dim). */
  function marker(): { t: number; live: boolean } | null {
    if (p.mode !== 'song') return null;
    if (playTick !== null) return { t: playTick, live: true };
    return p.playing ? null : { t: p.songPosition, live: false };
  }

  /** Reads every reactive input, so the $effect below redraws on any change. */
  function drawLanes() {
    const cv = canvas;
    const v = view;
    const W = width;
    const H = lanesH;
    if (!cv || !v || W <= 0 || H <= 0) return;
    const ctx = sizeCanvas(cv, W, H);
    if (!ctx) return;
    const t0 = xToTick(0, v);
    const t1 = xToTick(W, v);

    p.tracks.forEach((t, lane) => {
      ctx.fillStyle = t.id === p.selectedTrackId ? C.laneSel : lane % 2 ? C.laneB : C.laneA;
      ctx.fillRect(0, lane * LANE_H, W, LANE_H);
      ctx.fillStyle = '#16171b';
      ctx.fillRect(0, lane * LANE_H + LANE_H - 1, W, 1);
    });
    const vline = (t: number, style: string) => {
      ctx.fillStyle = style;
      ctx.fillRect(Math.round(tickToX(t, v)), 0, 1, H);
    };
    if (BEAT / v.ticksPerPx >= 8) for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) if (t % BAR) vline(t, C.beat);
    const step = barLabelStep(v.ticksPerPx);
    for (let t = snapFloor(t0, BAR); t <= t1; t += BAR) {
      const bar = t / BAR;
      if (bar % step === 0 || BAR / v.ticksPerPx >= 6) vline(t, bar % 4 === 0 ? C.bar4 : C.bar);
    }

    // loop range: faint over the lanes (dimmer while not live)
    const lx0 = tickToX(p.loop.start, v);
    const lx1 = tickToX(p.loop.end, v);
    if (lx1 > 0 && lx0 < W) {
      ctx.fillStyle = loopLive() ? 'rgba(240,162,58,0.07)' : 'rgba(240,162,58,0.025)';
      ctx.fillRect(lx0, 0, lx1 - lx0, H);
    }

    // clips (unselected first; the selection on top)
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const b of boxes) {
      const { t, c } = byId.get(b.id)!;
      const x0 = tickToX(c.start, v);
      const x1 = Math.max(tickToX(c.start + c.len, v), x0 + MIN_CLIP_W);
      if (x1 < 0 || x0 > W) continue;
      const isSel = selected.has(c.id);
      const y = b.lane * LANE_H + 2;
      const h = LANE_H - 5;
      const w = x1 - x0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y, w, h);
      ctx.clip();
      ctx.fillStyle = '#121317';
      ctx.fillRect(x0, y, w, h);
      ctx.globalAlpha = isSel ? 0.42 : 0.26;
      ctx.fillStyle = t.color;
      ctx.fillRect(x0, y, w, h);
      ctx.globalAlpha = 1;
      ctx.fillRect(x0, y, w, 2); // solid top edge in the track colour
      // repeat markers: a notch + dashed line where the pattern starts again
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (const r of repeatTicks(c.start, c.len, c.offset, patLenOf(t, c))) {
        const rx = Math.round(tickToX(r, v)) + 0.5;
        if (rx < x0 || rx > x1) continue;
        ctx.moveTo(rx, y + 2);
        ctx.lineTo(rx, y + h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      for (const r of repeatTicks(c.start, c.len, c.offset, patLenOf(t, c))) {
        const rx = Math.round(tickToX(r, v)) + 0.5;
        if (rx < x0 || rx > x1) continue;
        ctx.beginPath();
        ctx.moveTo(rx - 3, y + 2);
        ctx.lineTo(rx + 3, y + 2);
        ctx.lineTo(rx, y + 6);
        ctx.fill();
      }
      if (w > 18) { // name in the track colour; pinned to the left edge while scrolled
        ctx.fillStyle = t.color;
        ctx.fillText(patNameOf(t, c), Math.max(x0, 0) + 4, y + 5);
      }
      ctx.restore();
      ctx.lineWidth = isSel ? 1.5 : 1;
      ctx.strokeStyle = isSel ? '#ffffff' : t.color;
      ctx.globalAlpha = isSel ? 1 : 0.8;
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
      ctx.globalAlpha = 1;
      if (isSel && w > 14) { // resize grips
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0 + 2, y + 7, 1.5, h - 11);
        ctx.fillRect(x1 - 3.5, y + 7, 1.5, h - 11);
      }
    }

    if (box) {
      const bx = Math.min(box.x0, box.x1);
      const by = Math.min(box.y0, box.y1);
      ctx.fillStyle = 'rgba(240,162,58,0.12)';
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }

    const m = marker();
    if (m) {
      const x = Math.round(tickToX(m.t, v)) + 0.5;
      if (x >= 0 && x <= W) {
        ctx.fillStyle = m.live ? C.playhead : 'rgba(255,255,255,0.35)';
        ctx.fillRect(x - 0.75, 0, 1.5, H);
      }
    }
  }

  function drawRuler() {
    const cv = rulerCv;
    const v = view;
    const W = width;
    if (!cv || !v || W <= 0) return;
    const ctx = sizeCanvas(cv, W, RULER_H);
    if (!ctx) return;
    const t0 = xToTick(0, v);
    const t1 = xToTick(W, v);
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, W, RULER_H);

    // loop range band (bright while live, dim otherwise)
    const lx0 = tickToX(p.loop.start, v);
    const lx1 = tickToX(p.loop.end, v);
    if (lx1 > 0 && lx0 < W) {
      const live = loopLive();
      ctx.fillStyle = live ? 'rgba(240,162,58,0.42)' : 'rgba(240,162,58,0.14)';
      ctx.fillRect(lx0, 0, lx1 - lx0, RULER_H);
      ctx.fillStyle = live ? C.accent : 'rgba(240,162,58,0.45)';
      ctx.fillRect(Math.round(lx0), 0, 2, RULER_H);
      ctx.fillRect(Math.round(lx1) - 2, 0, 2, RULER_H);
    }

    ctx.textBaseline = 'middle';
    if (BEAT / v.ticksPerPx >= 8) {
      ctx.fillStyle = C.bar;
      for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) if (t % BAR) ctx.fillRect(Math.round(tickToX(t, v)), RULER_H - 5, 1, 5);
    }
    const step = barLabelStep(v.ticksPerPx);
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    for (let t = snapFloor(t0, BAR * step); t <= t1; t += BAR * step) {
      const x = Math.round(tickToX(t, v));
      ctx.fillStyle = C.bar4;
      ctx.fillRect(x, 0, 1, RULER_H);
      ctx.fillStyle = C.rulerText;
      ctx.fillText(String(t / BAR + 1), x + 4, RULER_H / 2 + 1);
    }

    const m = marker();
    if (m) {
      const x = tickToX(m.t, v);
      if (x >= -6 && x <= W + 6) {
        ctx.fillStyle = m.live ? C.playhead : 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, 9);
        ctx.fill();
        ctx.fillRect(Math.round(x) - 0.75, 0, 1.5, RULER_H);
      }
    }
  }

  function draw() {
    drawLanes();
    drawRuler();
  }
  $effect(() => draw());

  // Playhead: an rAF loop only while playing in Song mode. Follows the heard
  // position; when it runs off the right edge (or wraps out of view) the
  // view pages to it. `data-playhead` on the root mirrors it for tests.
  $effect(() => {
    if (!p.playing || p.mode !== 'song' || !clock) return;
    const c = clock;
    let raf = 0;
    let wasVisible = true;
    const loop = () => {
      const t = c.heardTicks();
      playTick = Number.isFinite(t) ? Math.max(0, t) : null;
      const v = view;
      if (playTick !== null && v && width > 0) {
        const x = tickToX(playTick, v);
        const visible = x >= 0 && x <= width - 12;
        if (!visible && wasVisible && !drag) view = clampView({ ...v, scrollTick: snapFloor(playTick, BAR) - BAR });
        wasVisible = visible || !!drag;
      }
      if (root) root.dataset.playhead = playTick === null ? '' : String(Math.round(playTick));
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      playTick = null;
      if (root) root.dataset.playhead = '';
      untrack(draw);
    };
  });

  // ---- pointer ---------------------------------------------------------------
  type Orig = { id: string; start: number; len: number; offset: number };
  type Drag =
    | { kind: 'move'; ids: string[]; orig: Orig[]; anchor: Orig; x0: number; y0: number; moved: boolean; last: number; laneHint: boolean; wasMulti: boolean; placed?: boolean }
    | { kind: 'left' | 'right'; orig: Orig; patLen: number; x0: number; moved: boolean; last: string }
    | { kind: 'box'; base: Set<string> }
    | {
        kind: 'ruler'; t0: number; x0: number; moved: boolean; last: string; loop: { on: boolean; start: number; end: number };
        /** Started while playing: the drag only previews (p.loop) and sends once on release. */
        quiet: boolean;
      };
  let drag: Drag | null = null;
  let pending: (() => void) | null = null;
  let raf = 0;

  function flush() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const f = pending;
    pending = null;
    f?.();
  }
  function schedule(f: () => void) {
    pending = f;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; flush(); });
  }

  const snapshot = (ids: Iterable<string>): Orig[] => {
    const out: Orig[] = [];
    for (const id of ids) {
      const f = byId.get(id);
      if (f) out.push({ id, start: f.c.start, len: f.c.len, offset: f.c.offset });
    }
    return out;
  };
  /** Point in lanes coordinates (content y: the scroll offset is in the bounding rect). */
  function local(e: { clientX: number; clientY: number }) {
    const r = lanesEl!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const focusLanes = () => lanesEl?.focus({ preventScroll: true });

  function down(e: PointerEvent) {
    if (e.button !== 0 || !view || !lanesEl) return;
    // macOS: Ctrl+click is a right click (the contextmenu event follows); do
    // not place or drag anything, and do not preventDefault so it still fires.
    if (IS_MAC && e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); // no text selection
    menu = null;
    focusLanes();
    const v = view;
    const { x, y } = local(e);
    const lane = yToLane(y, v);
    const t = p.tracks[lane];
    if (!t) return;
    const hit = hitTest(boxes, x, y, v);
    if (hit) {
      if (e.shiftKey) {
        const s = new Set(sel);
        if (s.has(hit.id)) s.delete(hit.id);
        else s.add(hit.id);
        selected = s;
        return;
      }
      const wasMulti = selected.has(hit.id) && sel.length > 1;
      if (!selected.has(hit.id)) selected = new Set([hit.id]);
      if (hit.part === 'body') {
        const orig = snapshot(sel);
        drag = { kind: 'move', ids: orig.map((o) => o.id), orig, anchor: orig.find((o) => o.id === hit.id)!, x0: x, y0: y, moved: false, last: 0, laneHint: false, wasMulti };
      } else {
        const f = byId.get(hit.id)!;
        selected = new Set([hit.id]);
        drag = { kind: hit.part, orig: snapshot([hit.id])[0], patLen: patLenOf(f.t, f.c), x0: x, moved: false, last: '' };
      }
    } else if (e.shiftKey) {
      drag = { kind: 'box', base: new Set(sel) };
      box = { x0: x, y0: y, x1: x, y1: y };
    } else {
      // Place the track's current pattern at the bar under the pointer.
      const tick = xToTick(x, v);
      let start = Math.max(0, e.altKey ? Math.round(tick) : snapFloor(tick, BAR));
      // A bar-snapped start can fall inside an earlier clip's tail (the click
      // itself was past its end): place after that clip instead of overlapping.
      for (let moved = true; moved;) {
        moved = false;
        for (const o of t.clips) {
          if (o.start <= start && start < o.start + o.len) {
            start = o.start + o.len;
            moved = true;
          }
        }
      }
      const len = placeLen(t.clips, start, patternLength(currentPattern(t)));
      const c = len >= 1 ? addClip(p, engine, t.id, { start, len }) : null;
      if (!c) {
        flashHint(t.clips.length >= 256 ? `${t.name} is full (256 clips)` : 'No room for a clip here');
        return;
      }
      selected = new Set([c.id]);
      const orig = snapshot([c.id]);
      drag = { kind: 'move', ids: [c.id], orig, anchor: orig[0], x0: x, y0: y, moved: false, last: 0, laneHint: false, wasMulti: false, placed: true };
    }
    lanesEl.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!view) return;
    const v = view;
    const { x, y } = local(e);
    if (!drag) return hover(x, y);
    if (drag.kind === 'box') {
      box = { ...box!, x1: x, y1: y };
      const s = new Set(drag.base);
      for (const id of boxSelect(boxes, box.x0, box.y0, x, y, v)) s.add(id);
      selected = s;
      return;
    }
    if (drag.kind === 'ruler') return;
    const dx = x - drag.x0;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP) {
      if (drag.kind === 'move' && Math.abs(y - drag.y0) >= LANE_H / 2) laneHintOnce(drag);
      return;
    }
    drag.moved = true;
    const dtRaw = dx * v.ticksPerPx;
    if (drag.kind === 'move') {
      const d = drag;
      if (yToLane(y, v) !== yToLane(d.y0, v)) laneHintOnce(d);
      const a = d.anchor;
      const want = e.altKey ? Math.round(dtRaw) : snap(a.start + dtRaw, BEAT) - a.start;
      const dt = clampGroupDt(d.orig, want);
      if (dt === d.last) return;
      d.last = dt;
      schedule(() => {
        const cur = byId.get(a.id)?.c.start;
        if (cur !== undefined) moveClips(p, engine, d.ids, a.start + dt - cur);
      });
    } else {
      const d = drag;
      const o = d.orig;
      const minLen = e.altKey ? 1 : Math.min(BEAT, o.len);
      let r: { start: number; len: number; offset: number };
      if (d.kind === 'right') {
        const end = o.start + o.len;
        r = { start: o.start, len: resizeRight(o, e.altKey ? end + dtRaw : snap(end + dtRaw, BEAT), minLen), offset: o.offset };
      } else {
        r = resizeLeft(o, e.altKey ? o.start + dtRaw : snap(o.start + dtRaw, BEAT), d.patLen, minLen);
      }
      const k = `${r.start},${r.len},${r.offset}`;
      if (k === d.last) return;
      d.last = k;
      schedule(() => resizeClip(p, engine, o.id, r));
    }
  }

  function laneHintOnce(d: { laneHint: boolean }) {
    if (d.laneHint) return;
    d.laneHint = true;
    flashHint('Clips stay on their own track (their pattern belongs to it)');
  }

  function hover(x: number, y: number) {
    const v = view!;
    if (!p.tracks[yToLane(y, v)]) {
      cursor = 'default';
      return;
    }
    const hit = hitTest(boxes, x, y, v);
    cursor = hit ? (hit.part === 'body' ? 'grab' : 'ew-resize') : 'copy';
  }

  function up(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    drag = null; // first: the lostpointercapture that follows must not cancel
    flush();
    if (d.kind === 'box') box = null;
    else if (d.kind === 'ruler' && d.moved && d.quiet) setLoop(p, engine, { ...p.loop }); // the one send
    else if (d.kind === 'move' && !d.moved && d.wasMulti && !e.shiftKey) selected = new Set([d.anchor.id]);
    else if (d.kind === 'ruler' && !d.moved) {
      seek(p, engine, seekTick(d.t0, e.altKey));
      // In Pattern mode the engine ignores the song position until SONG is on.
      if (p.mode === 'pattern') flashHint(`Song position set to bar ${Math.floor(p.songPosition / BAR) + 1} — plays in SONG`);
    }
  }

  /** Abort the drag and put the original values back. */
  function cancel() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    if (d.kind === 'box') {
      selected = d.base;
      box = null;
    } else if (d.kind === 'ruler') {
      // A quiet drag never reached the engine: re-sending the old loop would jump.
      if (d.moved) setLoop(p, d.quiet ? NO_SEND : engine, d.loop);
    } else if (d.kind === 'move' && d.placed) {
      // Escape on a place-and-drag: the clip never existed.
      deleteClips(p, engine, d.ids);
      selected = new Set();
    } else if (d.moved) {
      const origs = d.kind === 'move' ? d.orig : [d.orig];
      for (const o of origs) resizeClip(p, engine, o.id, { start: o.start, len: o.len, offset: o.offset });
    }
  }

  // ---- ruler ---------------------------------------------------------------------
  function rulerDown(e: PointerEvent) {
    if (e.button !== 0 || !view || !rulerCv) return;
    e.preventDefault();
    menu = null;
    focusLanes();
    const x = e.clientX - rulerCv.getBoundingClientRect().left;
    drag = { kind: 'ruler', t0: xToTick(x, view), x0: x, moved: false, last: '', loop: { ...p.loop }, quiet: p.playing };
    rulerCv.setPointerCapture(e.pointerId);
  }
  function rulerMove(e: PointerEvent) {
    if (!view || !rulerCv) return;
    const d = drag;
    if (d?.kind !== 'ruler') return;
    const x = e.clientX - rulerCv.getBoundingClientRect().left;
    if (!d.moved && Math.abs(x - d.x0) < DRAG_SLOP) return;
    d.moved = true;
    const r = loopFromDrag(d.t0, xToTick(x, view));
    const k = `${r.start},${r.end}`;
    if (k === d.last) return;
    d.last = k;
    schedule(() => setLoop(p, d.quiet ? NO_SEND : engine, { on: true, ...r }));
  }
  /**
   * A loop drag while playing updates p.loop (the ruler preview) without
   * telling the engine until release: the first drag frame could make a
   * tiny loop behind the playhead, which jumps, and Escape can't undo a jump.
   */
  const NO_SEND: CommandSink = { send: () => true };

  // ---- double-click / context menu --------------------------------------------------
  function dbl(e: MouseEvent) {
    if (!view) return;
    const { x, y } = local(e);
    const hit = hitTest(boxes, x, y, view);
    const f = hit && byId.get(hit.id);
    if (!f) return;
    selectTrack(p, engine, f.t.id);
    selectPattern(p, engine, f.t.id, f.c.patternId);
    flashHint(`Editing ${f.t.name} · ${patNameOf(f.t, f.c)} below`);
  }

  function context(e: MouseEvent) {
    e.preventDefault(); // never the browser's menu over the lanes
    if (!view || drag) return;
    const { x, y } = local(e);
    const hit = hitTest(boxes, x, y, view);
    const f = hit && byId.get(hit.id);
    if (!f) {
      menu = null;
      return;
    }
    if (!selected.has(f.c.id)) selected = new Set([f.c.id]);
    menu = { x: e.clientX, y: e.clientY, trackId: f.t.id, clipId: f.c.id };
  }
  const menuClip = $derived(menu ? byId.get(menu.clipId) ?? null : null);
  /** "Make unique" only means something when another clip shares the pattern. */
  const menuShared = $derived(menuClip ? uses(menuClip.t, menuClip.c.patternId) > 1 : false);
  const menuDeleteIds = $derived(menuClip ? (selected.has(menuClip.c.id) ? sel : [menuClip.c.id]) : []);

  function closeMenu() {
    menu = null;
    focusLanes();
  }
  function menuUnique() {
    if (!menu || !menuClip) return;
    const pat = makeUnique(p, engine, menu.trackId, menu.clipId);
    if (pat) flashHint(`Clip now plays "${pat.name}" (a copy): edits no longer affect the others`);
    else flashHint(`${menuClip.t.name} has no room for another pattern (16 max)`);
    closeMenu();
  }
  function menuDelete() {
    deleteClips(p, engine, menuDeleteIds);
    selected = new Set();
    closeMenu();
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  }
  // Keep the menu inside the window: once it is measured, pull it back from
  // the right / bottom edge (re-runs once with the corrected position, then settles).
  $effect(() => {
    const m = menu;
    const el = menuEl;
    if (!m || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4));
    if (x !== m.x || y !== m.y) menu = { ...m, x, y };
  });
  // Outside click closes the menu (capture: before anything else reacts).
  $effect(() => {
    if (!menu) return;
    const el = menuEl;
    untrack(() => (el?.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus());
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) menu = null;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });

  // ---- wheel (non-passive, so it can stop the page scrolling / zooming) -----
  function onWheel(e: WheelEvent, overRuler: boolean) {
    if (!view || !lanesEl) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const x = e.clientX - lanesEl.getBoundingClientRect().left;
      view = clampView(zoomAt(view, Math.exp(dy * 0.002), Math.max(0, x), ZOOM));
    } else if (overRuler || e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
      view = clampView({ ...view, scrollTick: view.scrollTick + (Math.abs(dx) > Math.abs(dy) ? dx : dy) * view.ticksPerPx });
    } // else: native vertical scroll of the lanes
  }
  $effect(() => {
    const l = lanesEl;
    const r = rulerCv;
    if (!l || !r) return;
    const onLanes = (e: WheelEvent) => onWheel(e, false);
    const onRuler = (e: WheelEvent) => onWheel(e, true);
    l.addEventListener('wheel', onLanes, { passive: false });
    r.addEventListener('wheel', onRuler, { passive: false });
    return () => {
      l.removeEventListener('wheel', onLanes);
      r.removeEventListener('wheel', onRuler);
    };
  });

  // ---- keyboard (see KEYBOARD FOCUS RULE at the top) ---------------------------
  function nudge(dt: number) {
    const dts = clampGroupDt(snapshot(sel), dt);
    if (dts) moveClips(p, engine, sel, dts);
  }
  function key(e: KeyboardEvent) {
    if (e.target !== lanesEl) return; // keys from the menu / headers are not ours
    const cmd = e.metaKey || e.ctrlKey;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      take();
      if (drag) cancel();
      else if (menu) menu = null;
      else selected = new Set();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !cmd && !e.altKey) {
      take();
      if (sel.length && !drag) {
        deleteClips(p, engine, sel);
        selected = new Set();
      }
    } else if (e.code === 'KeyD' && cmd && !e.altKey) {
      take();
      releaseHeldKeys(); // the shortcuts would have, on Meta (macOS eats keyups during Cmd chords)
      if (e.repeat || drag || !sel.length) return;
      const copies = duplicateClips(p, engine, sel);
      if (copies.length) selected = new Set(copies.map((c) => c.id));
      if (copies.length < sel.length) flashHint('Some copies did not fit (song end or 256 clips per track)');
    } else if (e.code === 'KeyA' && cmd && !e.altKey) {
      take();
      releaseHeldKeys();
      selected = new Set(byId.keys());
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !cmd && !e.altKey && sel.length && !drag) {
      take();
      const step = e.shiftKey ? BAR : BEAT;
      nudge(e.key === 'ArrowLeft' ? -step : step);
    }
  }

  // ---- overlays (testids, tooltips, labels) ---------------------------------------
  const overlays = $derived.by(() => {
    const v = view;
    return p.tracks.map((t) => ({
      t,
      clips: v
        ? t.clips.map((c) => {
          const left = tickToX(c.start, v);
          const name = patNameOf(t, c);
          return {
            c,
            name,
            left,
            width: Math.max(MIN_CLIP_W, c.len / v.ticksPerPx),
            label: `${t.name} · ${name} · ${barRange(c.start, c.len)}`,
          };
        })
        : [],
    }));
  });

  onDestroy(() => {
    flush();
    clearTimeout(hintTimer);
  });
</script>

<div
  class="tl"
  bind:this={root}
  data-testid="timeline"
  data-view={view ? JSON.stringify(view) : ''}
  data-playhead=""
  style:--header-w="{HEADER_W}px"
  style:--ruler-h="{RULER_H}px"
  style:--lane-h="{LANE_H}px"
>
  <div class="scroll">
    <div class="grid">
      <div class="corner">Tracks</div>
      <div class="ruler-wrap">
        <canvas
          bind:this={rulerCv}
          class="ruler"
          data-testid="tl-ruler"
          aria-label="Ruler: click to set the song position, drag to set the loop range (bars {Math.floor(p.loop.start / BAR) + 1}–{Math.ceil(p.loop.end / BAR)}{p.loop.on ? ', loop on' : ', loop off'})"
          data-loop="{p.loop.start},{p.loop.end},{p.loop.on ? 1 : 0}"
          title="Click: set the song position (Alt: exact). Drag: set the loop range."
          onpointerdown={rulerDown}
          onpointermove={rulerMove}
          onpointerup={up}
          onpointercancel={cancel}
          onlostpointercapture={cancel}
        ></canvas>
      </div>
      <TrackHeaders {p} {engine} />
      <!-- Focusable so the timeline keys (KEYBOARD FOCUS RULE) reach it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="lanes"
        bind:this={lanesEl}
        style:height="{lanesH}px"
        style:cursor
        tabindex="0"
        role="application"
        aria-label="Song arrangement. Click a lane to place its pattern; Delete removes, Cmd+D duplicates, arrows nudge."
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={cancel}
        onlostpointercapture={cancel}
        onpointerleave={() => { if (!drag) cursor = 'default'; }}
        ondblclick={dbl}
        oncontextmenu={context}
        onkeydown={key}
      >
        <canvas bind:this={canvas} class="lanes-cv"></canvas>
        {#each overlays as o, lane (o.t.id)}
          <div class="lane" data-testid="tl-lane-{o.t.slot}" style:top="{lane * LANE_H}px" title="{o.t.name}: click to place {currentPattern(o.t).name}">
            {#each o.clips as k (k.c.id)}
              <div
                class="clip"
                data-testid="clip-{o.t.slot}-{k.c.idx}"
                data-start={k.c.start}
                data-len={k.c.len}
                data-offset={k.c.offset}
                data-pattern={k.name}
                data-selected={selected.has(k.c.id)}
                aria-label={k.label}
                title="{k.label} — drag to move, edges resize, double-click to edit, right-click for more"
                style:left="{k.left}px"
                style:width="{k.width}px"
              ></div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
    <div class="foot">
      <!-- Disabled at MAX_TRACKS (the engine has 32 slots), with a reason. -->
      <button data-testid="add-drum-track" disabled={tracksFull} title={tracksFull ? FULL_TITLE : 'Add a drum track'} onclick={() => addDrumTrack(p, engine)}>+ Drum track</button>
      <button data-testid="add-synth-track" disabled={tracksFull} title={tracksFull ? FULL_TITLE : 'Add a synth track (Deep Bass)'} onclick={() => addSynthTrack(p, engine, undefined, deepBass)}>+ Synth track</button>
      <!-- Mouse users without a wheel / trackpad: a plain scrollbar for time. -->
      <input
        class="hscroll"
        type="range"
        data-testid="tl-hscroll"
        aria-label="Scroll the timeline"
        min="0"
        max={Math.max(0, MAX_SONG_TICKS - width * (view?.ticksPerPx ?? 1))}
        step={BAR / 4}
        value={view?.scrollTick ?? 0}
        oninput={(e) => { if (view) view = clampView({ ...view, scrollTick: Number(e.currentTarget.value) }); }}
      />
      <output class="readout" class:hint={!!hint} data-testid="tl-readout">{readoutText}</output>
    </div>
  </div>
  {#if menu && menuClip}
    <div
      class="menu"
      bind:this={menuEl}
      data-testid="tl-menu"
      role="menu"
      tabindex="-1"
      style:left="{menu.x}px"
      style:top="{menu.y}px"
      onkeydown={menuKey}
      oncontextmenu={(e) => e.preventDefault()}
    >
      <div class="menu-ttl">{menuClip.t.name} · {patNameOf(menuClip.t, menuClip.c)}</div>
      <button
        role="menuitem"
        data-testid="tl-menu-unique"
        disabled={!menuShared}
        title={menuShared ? 'Give this clip its own copy of the pattern' : 'Only this clip uses this pattern'}
        onclick={menuUnique}
      >Make unique</button>
      <button role="menuitem" data-testid="tl-menu-delete" onclick={menuDelete}>
        Delete{menuDeleteIds.length > 1 ? ` ${menuDeleteIds.length} clips` : ''}
      </button>
    </div>
  {/if}
</div>

<style>
  .tl { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; }
  .scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; }
  .grid { display: grid; grid-template-columns: var(--header-w) minmax(0, 1fr); flex: 1 0 auto; align-content: start; }
  .corner, .ruler-wrap { position: sticky; top: 0; z-index: 2; height: var(--ruler-h); background: #202227; border-bottom: 1px solid #2a2c33; }
  .corner { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #7d808c; line-height: var(--ruler-h); padding-left: 8px; }
  .ruler-wrap { min-width: 0; }
  .ruler { display: block; width: 100%; height: var(--ruler-h); cursor: text; touch-action: none; }
  .lanes { position: relative; min-width: 0; overflow: hidden; outline: none; touch-action: none; background: #17181c; }
  .lanes:focus-visible { box-shadow: inset 0 0 0 1px #f0a23a88; }
  .lanes-cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .lane { position: absolute; left: 0; right: 0; height: var(--lane-h); }
  .clip { position: absolute; top: 2px; height: 23px; }
  .foot { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: #1b1c21; border-top: 1px solid #2a2c33; }
  .foot button { font: inherit; font-size: 11px; padding: 2px 8px; border: 1px solid #3a3d48; border-radius: 3px; background: #24262c; color: #c9cbd3; cursor: pointer; white-space: nowrap; }
  .foot button:hover { background: #2e313a; }
  .foot button:focus-visible { outline: 2px solid #f0a23a; outline-offset: -2px; }
  .hscroll { width: 140px; flex: none; margin-left: 8px; accent-color: #f0a23a; }
  .readout { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9cbd3; }
  .readout.hint { color: #ffd98a; }
  .menu { position: fixed; z-index: 50; min-width: 150px; padding: 4px; background: #24262c; border: 1px solid #3a3d48; border-radius: 4px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; }
  .menu-ttl { font-size: 10px; color: #8d90a0; padding: 2px 6px 4px; white-space: nowrap; }
  .menu button { font: inherit; text-align: left; padding: 4px 8px; border: 0; border-radius: 3px; background: transparent; color: #e4e5ea; cursor: pointer; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: #343846; outline: none; }
  .menu button:disabled { color: #6d707c; cursor: not-allowed; }
</style>
