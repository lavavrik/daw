<script lang="ts">
  // Song timeline (the top-centre Song pane, layout B). Replaces the plan-2
  // track list: the track headers are its left column.
  //
  // Layout: one vertical scroll container (native scrolling, so headers and
  // lanes stay aligned when many tracks exist):
  //   corner "Tracks"      | ruler canvas (sticky top): bar numbers, loop range
  //   track headers (HTML) | lanes: canvas (grid, loop shading, clips, playhead)
  //                        |        + transparent DOM overlays per lane / clip
  //   drop zone below the last lane (`tl-below`): drop audio for a new track
  //   footer (sticky bottom): + Drum / Synth / Audio track, readout
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
  // AUDIO LANES (plan 9; spec addendum §3.1/3.2). An Audio track's clips draw,
  // in the track colour: the min/max waveform from the sample's peaks
  // (audio/peaks.ts, the level that matches the zoom; scaled by the clip's
  // gain and fades; a flat line until peaks exist), the sample name, the
  // fade ramps, for a loop clip a notch every file length (where the file
  // starts again), and for a one-shot clip whose file runs out before the clip
  // ends (a tempo change: clips play at native speed) an end-of-file mark with
  // the silent rest dimmed. A clip whose sample is still waiting for Stop
  // (a DEFERRED load, sampleLoads.ts pendingSampleIds) is hatched; one whose
  // sample is gone is hatched red and named "missing sample".
  // Drops (Finder files, a library or starter-kit sample; library/drag.ts
  // droppedFiles) are handled on the whole scroll area and resolved by
  // tlMath.dropTarget: an Audio lane places the files at the beat under the
  // pointer (Alt: the exact tick), one after another; below the last lane a
  // new Audio track is made for them; a drum / synth lane (or the ruler) only
  // shows the hint. Every file is imported first (sampleImport.ts: decode,
  // budget check, peaks, upload); then the track and all clips are placed in
  // ONE edit, so one undo takes the whole drop back.
  // Audio clips move between Audio lanes (vertical drag; a pointer over a
  // non-audio lane keeps them where they are), their right edge stops at the
  // end of a one-shot file, and the left edge trims (trimAudioClipStart: the
  // audio stays put). Clicking an audio clip selects its track, so the
  // bottom panel's Clip tab (ClipPanel.svelte, Alt+5) edits it (clipFocus).
  //
  // AUTOMATION (plan 10; spec addendum §3.4). Rows are not uniform: the
  // layout map (tlMath.rowLayout) stacks, under each track's clip row
  // (LANE_H), its automation lanes (AUTO_H each) while the track is open (its
  // header's A; laneView.open, UI state), and pins the Master row (the
  // master's and the returns' lanes) under the last track once it has a lane
  // or "+ Master row" asked for it. EVERY y question goes through the map:
  // drawing, the clip hit tests and box selection (clip rows only), the
  // cross-lane move of audio clips (over a lane row they stay where they
  // are), drops (dropTarget: a lane row or the Master row only hints), and
  // the header column (TrackHeaders renders the same rows). A lane row is an
  // AutoLane (its own canvas, pointer and keys; see there); the main canvas
  // only paints its background and the grid under it.
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
  // - right-click a clip: in-app menu (Make unique, Split here, Loop to fill
  //   for an audio clip, Delete); Escape or a click outside closes it.
  //   "Split here" splits the clip (or the selection holding it) at the beat
  //   under the right-click (Alt: the exact tick);
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
  //   Cmd/Ctrl+E           split the selected clips at the playhead (playing in
  //                        Song mode) or the parked song position
  //   Escape               cancel a drag / close the menu, else clear the selection
  //   ← / →                nudge the selection one beat (Shift: one bar)
  // Every other key bubbles on: letters keep playing the QWERTY piano, Space
  // toggles the transport, Shift+L toggles PAT/SONG.
  import { onDestroy, untrack } from 'svelte';
  import type { CommandSink } from '../../state/actions';
  import { TRACKS_FULL_TEXT, addDrumTrack, selectTrack } from '../../state/actions';
  import type { ImportEngine } from '../../state/sampleImport';
  import { dropAudioFiles } from '../../state/audioDrop';
  import { pendingSampleIds, sampleFailed } from '../../state/sampleLoads';
  import { banners } from '../../state/banners.svelte';
  import { droppedFiles, isSampleDrag } from '../../library/drag';
  import { peaksFrames, peaksLevel } from '../../audio/peaks';
  import { clipFocus, sampleName } from './clipFocus.svelte';
  import { addSynthTrack } from '../../state/rack-actions';
  import { addSamplerTrack } from '../../state/sampler-actions';
  import { STARTER_PATCHES } from '../../state/patches';
  import type { AudioClock } from '../../audio/audioClock';
  import type { AudioClip, AutomationLane, Clip, Project, Track } from '../../state/project.svelte';
  import type { AutoOwner } from '../../state/automation';
  import { MAX_TRACKS, currentPattern, isPatternTrack, patternLength } from '../../state/project.svelte';
  import { patternOf, selectPattern } from '../../state/pattern-actions';
  import {
    deleteClips, duplicateClips, makeUnique, moveClips, resizeClip, seek, setLoop, addClip, splitClips,
  } from '../../state/song-actions';
  import { addAudioTrack, clipGainLinear, fileSeconds, setAudioClip, trimAudioClipStart } from '../../state/audio-actions';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { MAX_SONG_TICKS } from '../../audio/protocol';
  import TrackHeaders from './TrackHeaders.svelte';
  import AutoLane from './AutoLane.svelte';
  import { laneView, setOpen } from './laneView.svelte';
  import { targetLabel } from './autoLabels';
  import { targetDef } from '../../state/automation';
  import {
    AUTO_H, BAR, BEAT, HEADER_W, LANE_H, MASTER_GREY, MASTER_ROW, MIN_CLIP_W, RULER_H, ZOOM, audioEdges, audioMarks,
    barLabelStep, barRange, boxSelect, clampGroupDt, clipLaneAt, dropTarget, fileTicks, followPage, hitTest, loopFromDrag, placeLen,
    repeatTicks, resizeLeft, resizeRight, rowLayout, rowsHeight, seekTick, snap, snapFloor, tickToX, xToTick, zoomAt,
  } from './tlMath';
  import type { ClipBox, TlView } from './tlMath';

  let { p, engine, clock }: { p: Project; engine: CommandSink & ImportEngine; clock: AudioClock | null } = $props();

  const deepBass = STARTER_PATCHES.find((x) => x.name === 'Deep Bass') ?? STARTER_PATCHES[0];
  const tracksFull = $derived(p.tracks.length >= MAX_TRACKS);
  const FULL_TITLE = TRACKS_FULL_TEXT;
  /** What a drop on a drum or synth lane says (addendum §3.1). */
  const DROP_HINT = 'Drop audio on an audio track or below the tracks';
  /** Pixels a press must travel before it counts as a drag (a click never moves a clip). */
  const DRAG_SLOP = 3;
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  /** Bars visible when the timeline first opens. */
  const OPEN_BARS = 16;

  // ---- state -------------------------------------------------------------
  let root = $state<HTMLDivElement | null>(null);
  let lanesEl = $state<HTMLDivElement | null>(null);
  /** The vertical scroll container (AutoLane draws only the lanes in its view). */
  let scrollEl = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  /** Transparent canvas over the lanes: the playhead only (drawPlayhead). */
  let ovCanvas = $state<HTMLCanvasElement | null>(null);
  let rulerCv = $state<HTMLCanvasElement | null>(null);
  let width = $state(0);
  let dpr = $state(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  let view = $state.raw<TlView | null>(null);
  let selected = $state.raw<Set<string>>(new Set());
  /** Box selection rectangle in lanes px. */
  let box = $state.raw<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The clip menu; `tick`: where "Split here" splits (the beat under the right-click, Alt: exact). */
  let menu = $state.raw<{ x: number; y: number; trackId: string; clipId: string; tick: number } | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let hint = $state<string | null>(null);
  let cursor = $state('default');
  /** Where a sample drag over the timeline would land (drawn as a highlight). */
  let dropHover = $state.raw<{ lane: number } | 'new' | null>(null);

  type Found = { t: Track; c: Clip | AudioClip; lane: number };
  // The layout map (see AUTOMATION at the top): every row's y and height.
  /** The Master row shows once it has a lane, or when asked for (footer, Task 4's "Automate"). */
  const masterShown = $derived(p.mixer.automation.length > 0 || laneView.master);
  // Once the Master row has a lane (added, loaded, undone back) it was asked
  // for: removing its last lane later keeps the row (its × hides it).
  $effect(() => {
    if (p.mixer.automation.length > 0) untrack(() => (laneView.master = true));
  });
  const layout = $derived(rowLayout(p.tracks, laneView.open, masterShown ? p.mixer.automation.map((x) => x.lane) : null));
  const lanesH = $derived(rowsHeight(layout));
  /** Content y of each track's clip row, by track index (clip rows are in track order). */
  const clipY = $derived(layout.filter((r) => r.kind === 'clips').map((r) => r.y));
  /** The automation lane rows, ready for AutoLane (a lane whose target is gone is skipped). */
  const autoRows = $derived.by(() => {
    const out = [];
    const info = new Map<string, { lane: AutomationLane; owner: AutoOwner; k: number; key: string; color: string }>();
    for (const t of p.tracks) t.automation.forEach((lane, k) => info.set(lane.id, { lane, owner: t, k, key: String(t.slot), color: t.color }));
    p.mixer.automation.forEach((x, k) => info.set(x.lane.id, { lane: x.lane, owner: x.channel, k, key: 'm', color: MASTER_GREY }));
    for (const r of layout) {
      if (r.kind !== 'lane') continue;
      const f = r.laneId ? info.get(r.laneId) : undefined;
      const def = f ? targetDef(f.owner, f.lane.target) : null;
      if (f && def) out.push({ row: r, ...f, def, label: targetLabel(f.owner, f.lane.target) });
      else if (!r.laneId) out.push({ row: r, empty: true as const });
    }
    return out;
  });
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

  // Audio clips (plan 9) have no pattern: the sample name stands in for the
  // pattern name, and their lanes are drawn by drawAudio.
  const isAudio = (c: Clip | AudioClip): c is AudioClip => 'sampleId' in c;
  const patternClip = (t: Track, c: Clip | AudioClip) => ('patternId' in c && isPatternTrack(t) ? { t, c } : null);
  const patLenOf = (t: Track, c: Clip | AudioClip) => {
    const pc = patternClip(t, c);
    const pat = pc && patternOf(pc.t, pc.c.patternId);
    return pat ? patternLength(pat) : pc ? BAR : c.len;
  };
  const patNameOf = (t: Track, c: Clip | AudioClip) => {
    const pc = patternClip(t, c);
    if (pc) return patternOf(pc.t, pc.c.patternId)?.name ?? '?';
    const id = 'sampleId' in c ? c.sampleId : null;
    return sampleName(p, id);
  };
  const uses = (t: Track, patternId: string) => t.clips.filter((c) => 'patternId' in c && c.patternId === patternId).length;

  const readoutText = $derived.by(() => {
    if (hint) return hint;
    if (sel.length === 1) {
      const { t, c } = byId.get(sel[0])!;
      if (isAudio(c)) {
        const secs = fileSeconds(p, c.sampleId);
        const file = secs === null ? '' : ` · ${secs.toFixed(2)} s file`;
        return `${t.name} · ${patNameOf(t, c)} · ${barRange(c.start, c.len)}${c.loop ? ' · loop' : ''}${file} · Alt+5 edits gain and fades`;
      }
      const reps = c.len / patLenOf(t, c);
      const times = Number.isInteger(reps) ? `×${reps}` : `×${reps.toFixed(2)}`;
      const pc = patternClip(t, c);
      const inEditor = !pc || (p.selectedTrackId === t.id && pc.t.currentPatternId === pc.c.patternId);
      return `${t.name} · ${patNameOf(t, c)} · ${barRange(c.start, c.len)} · ${times}${inEditor ? '' : ' · double-click to edit'}`;
    }
    if (sel.length > 1) return `${sel.length} clips selected`;
    if (p.mode === 'pattern' && byId.size) return 'Pattern mode: tracks loop their pattern — SONG (Shift+L) plays the timeline';
    return 'Click a lane to place its pattern · drop audio files on the timeline · drag the ruler to loop';
  });

  /**
   * An audio clip was clicked or placed: the Clip tab edits it (clipFocus),
   * and its track becomes the selected one so the bottom panel shows that tab.
   */
  function focusAudio(t: Track, c: AudioClip) {
    clipFocus.id = c.id;
    if (p.selectedTrackId !== t.id) selectTrack(p, engine, t.id);
  }
  // A selection of exactly one audio clip (a box select, a nudge, an undo) is the one the Clip tab edits.
  $effect(() => {
    if (sel.length !== 1) return;
    const f = byId.get(sel[0]);
    if (f && isAudio(f.c)) untrack(() => (clipFocus.id = f.c.id));
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
        if (!view && width > 0) view = clampView({ ticksPerPx: (OPEN_BARS * BAR) / width, scrollTick: 0 });
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
    bar4: '#4a4e5b', auto: '#191a1f', master: '#202128', ruler: '#202227', rulerText: '#c9cbd3', dimText: '#7d808c', accent: '#f0a23a', playhead: '#ffffff',
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

    for (const r of layout) {
      if (r.kind === 'clips') ctx.fillStyle = r.trackId === p.selectedTrackId ? C.laneSel : r.track % 2 ? C.laneB : C.laneA;
      else ctx.fillStyle = r.kind === 'master' ? C.master : C.auto; // AutoLane draws the curve on its own canvas
      ctx.fillRect(0, r.y, W, r.h);
      ctx.fillStyle = '#16171b';
      ctx.fillRect(0, r.y + r.h - 1, W, 1);
    }
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

    // Audio lanes redraw when peaks land (peaksVersion) and when a deferred
    // load settles (the "will load when playback stops" notice clears then).
    void p.peaksVersion;
    void banners.notice;
    const pending = new Set(pendingSampleIds());

    // A sample drag over an audio lane: that lane lights up.
    if (dropHover && dropHover !== 'new') {
      ctx.fillStyle = 'rgba(240,162,58,0.16)';
      ctx.fillRect(0, clipY[dropHover.lane] ?? 0, W, LANE_H - 1);
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
      const y = (clipY[b.lane] ?? 0) + 2;
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
      if (isAudio(c)) drawAudio(ctx, t.color, c, x0, x1, y, h, v, W, pending);
      else drawRepeats(ctx, t.color, repeatTicks(c.start, c.len, c.offset, patLenOf(t, c)), x0, x1, y, h, v);
      if (w > 18) { // name in the track colour; pinned to the left edge while scrolled
        const st = isAudio(c) ? audioState(c, pending) : null;
        const name = patNameOf(t, c) + (st === 'failed' ? ' · sample failed to load' : '');
        if (isAudio(c)) { // over the waveform: on a dark backing
          ctx.fillStyle = 'rgba(18,19,23,0.75)';
          ctx.fillRect(Math.max(x0, 0) + 2, y + 3, ctx.measureText(name).width + 4, 12);
        }
        ctx.fillStyle = st === 'missing' || st === 'failed' ? MISSING : t.color;
        ctx.fillText(name, Math.max(x0, 0) + 4, y + 5);
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
  }

  /**
   * The playhead / parked position over the lanes, on its own transparent
   * canvas on top: while playing only this (and the ruler) is redrawn every
   * frame, never the lanes and their waveforms.
   */
  function drawPlayhead() {
    const cv = ovCanvas;
    const v = view;
    const W = width;
    const H = lanesH;
    if (!cv || !v || W <= 0 || H <= 0) return;
    const ctx = sizeCanvas(cv, W, H);
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const m = marker();
    if (m) {
      const x = Math.round(tickToX(m.t, v)) + 0.5;
      if (x >= 0 && x <= W) {
        ctx.fillStyle = m.live ? C.playhead : 'rgba(255,255,255,0.35)';
        ctx.fillRect(x - 0.75, 0, 1.5, H);
      }
    }
  }

  /** A notch + dashed line at each tick where the clip's material starts again (pattern, or a loop clip's file). */
  function drawRepeats(ctx: CanvasRenderingContext2D, color: string, ticks: number[], x0: number, x1: number, y: number, h: number, v: TlView) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const r of ticks) {
      const rx = Math.round(tickToX(r, v)) + 0.5;
      if (rx < x0 || rx > x1) continue;
      ctx.moveTo(rx, y + 2);
      ctx.lineTo(rx, y + h);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    for (const r of ticks) {
      const rx = Math.round(tickToX(r, v)) + 0.5;
      if (rx < x0 || rx > x1) continue;
      ctx.beginPath();
      ctx.moveTo(rx - 3, y + 2);
      ctx.lineTo(rx + 3, y + 2);
      ctx.lineTo(rx, y + 6);
      ctx.fill();
    }
  }

  const MISSING = '#ff8a92';

  /**
   * What is wrong with an audio clip's sample, if anything: `missing` (none:
   * not in the project folder), `failed` (its deferred load failed:
   * sampleLoads.sampleFailed; it plays nothing), `pending` (its deferred
   * load waits for Stop). Drawn hatched (red for the first two), and said in
   * the overlay's aria-label and data-state.
   */
  function audioState(c: AudioClip, pending: ReadonlySet<number>): 'missing' | 'failed' | 'pending' | null {
    if (c.sampleId === null) return 'missing';
    if (sampleFailed(c.sampleId)) return 'failed';
    return pending.has(c.sampleId) ? 'pending' : null;
  }
  const STATE_TEXT = { missing: 'missing sample', failed: 'sample failed to load: stop and drop it again', pending: 'loads when playback stops' };

  /** Diagonal stripes over [x0, x1) × [y, y + h) (the caller has clipped to the clip). */
  function hatch(ctx: CanvasRenderingContext2D, color: string, x0: number, x1: number, y: number, h: number) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    for (let x = Math.floor(x0 / 8) * 8 - h; x < x1; x += 8) {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * An audio clip's body (see AUDIO LANES at the top): the waveform, the
   * fade ramps, the loop notches or the end-of-file mark, and the hatch of a
   * deferred or missing sample. The caller has clipped to the clip's box and
   * draws the name and the outline.
   */
  function drawAudio(
    ctx: CanvasRenderingContext2D, color: string, c: AudioClip, x0: number, x1: number, y: number, h: number,
    v: TlView, W: number, pending: Set<number>,
  ) {
    const meta = c.sampleId !== null ? p.sampleMeta.get(c.sampleId) : undefined;
    const seconds = meta?.seconds ?? null;
    const tps = fileTicks(1, p.tempo); // ticks per second
    const end = c.start + c.len;
    const top = y + 3; // full height: the name is drawn over it on a dark backing
    const bottom = y + h - 1;
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

    ctx.fillStyle = color;
    if (meta?.peaks && seconds && seconds > 0) {
      const pk = meta.peaks;
      const frames = peaksFrames(pk);
      const fps = frames / seconds; // file frames per second (the rate the peaks were made at)
      const lv = peaksLevel(pk, (v.ticksPerPx / tps) * fps);
      const pairs = lv.data[0]?.length / 2 || 0;
      ctx.globalAlpha = 0.9;
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
    } else if (!pending.has(c.sampleId ?? -1) && c.sampleId !== null) {
      // No peaks yet: a flat placeholder line.
      ctx.globalAlpha = 0.5;
      ctx.fillRect(xa, Math.round(mid), xb - xa, 1);
      ctx.globalAlpha = 1;
    }

    // Fade ramps: the faded-out corner dimmed, the ramp drawn as a line.
    const ramp = (xs: number, ys: number, xe: number, ye: number, corner: [number, number]) => {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.moveTo(xs, ys);
      ctx.lineTo(xe, ye);
      ctx.lineTo(corner[0], corner[1]);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.7;
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

    const marks = audioMarks(c, seconds, p.tempo);
    if (marks.repeats.length) drawRepeats(ctx, color, marks.repeats, x0, x1, y, h, v);
    if (marks.fileEnd !== null) {
      // The file runs out before the clip ends (a tempo change): the rest is silent.
      const xe = Math.round(tickToX(marks.fileEnd, v));
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(xe, y + 2, x1 - xe, h - 2);
      ctx.fillStyle = '#ffd98a';
      ctx.fillRect(xe, y + 2, 1.5, h - 2);
      ctx.beginPath();
      ctx.moveTo(xe, y + h);
      ctx.lineTo(xe + 4, y + h);
      ctx.lineTo(xe, y + h - 4);
      ctx.fill();
    }

    const st = audioState(c, pending);
    if (st === 'missing' || st === 'failed') hatch(ctx, MISSING, x0, x1, y, h);
    else if (st === 'pending') hatch(ctx, color, x0, x1, y, h);
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
    drawPlayhead();
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
        // Never under a press: a clip drag here, or an AutoLane gesture (laneView.gesture).
        const f = followPage(v, playTick, width, wasVisible, !!drag || laneView.gesture);
        if (f.scrollTick !== null) view = clampView({ ...v, scrollTick: f.scrollTick });
        wasVisible = f.visible;
      }
      if (root) root.dataset.playhead = playTick === null ? '' : String(Math.round(playTick));
      drawPlayhead(); // the lanes redraw only when something they show changes ($effect above)
      drawRuler();
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
    | {
        kind: 'move'; ids: string[]; orig: Orig[]; anchor: Orig; x0: number; y0: number; moved: boolean; last: string; laneHint: boolean; wasMulti: boolean; placed?: boolean;
        /** The anchor's lane at the press (audio clips change lanes: Escape moves them back). */
        anchorLane: number;
        /** Every dragged clip is an audio clip, so the group may change lanes. */
        audio: boolean;
      }
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
    const lane = clipLaneAt(layout, y); // -1: the Master row (lane rows are AutoLane's own)
    const t = p.tracks[lane];
    if (!t) return;
    const hit = hitTest(boxes, x, y, v, layout);
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
      const hf = byId.get(hit.id)!;
      if (isAudio(hf.c)) focusAudio(hf.t, hf.c);
      if (hit.part === 'body') {
        const orig = snapshot(sel);
        const audio = orig.every((o) => { const c = byId.get(o.id)?.c; return !!c && isAudio(c); });
        drag = {
          kind: 'move', ids: orig.map((o) => o.id), orig, anchor: orig.find((o) => o.id === hit.id)!, x0: x, y0: y, moved: false,
          last: '', laneHint: false, wasMulti, anchorLane: hf.lane, audio,
        };
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
      if (!isPatternTrack(t)) {
        flashHint('Drop an audio file on this lane to place it');
        return;
      }
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
      drag = {
        kind: 'move', ids: [c.id], orig, anchor: orig[0], x0: x, y0: y, moved: false, last: '', laneHint: false, wasMulti: false,
        placed: true, anchorLane: lane, audio: false,
      };
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
      for (const id of boxSelect(boxes, box.x0, box.y0, x, y, v, layout)) s.add(id);
      selected = s;
      return;
    }
    if (drag.kind === 'ruler') return;
    const dx = x - drag.x0;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP) {
      if (drag.kind === 'move' && Math.abs(y - drag.y0) >= LANE_H / 2) {
        if (!drag.audio) laneHintOnce(drag);
        else {
          drag.moved = true; // a vertical drag of audio clips moves them to another lane
          move(e);
        }
      }
      return;
    }
    drag.moved = true;
    const dtRaw = dx * v.ticksPerPx;
    if (drag.kind === 'move') {
      const d = drag;
      // Through the layout map: -1 over an automation lane or the Master row.
      const overLane = clipLaneAt(layout, y);
      if (overLane >= 0 && overLane !== d.anchorLane && !d.audio) laneHintOnce(d);
      const a = d.anchor;
      const want = e.altKey ? Math.round(dtRaw) : snap(a.start + dtRaw, BEAT) - a.start;
      const dt = clampGroupDt(d.orig, want);
      // Audio clips follow the pointer onto another Audio lane; over any other
      // lane they stay on the one they are on (moveClips' dLane counts places
      // in the whole track list, so the target must itself be an Audio lane).
      const lane = d.audio && p.tracks[overLane]?.kind === 'audio' ? overLane : -1;
      const k = `${dt},${lane}`;
      if (k === d.last) return;
      d.last = k;
      schedule(() => {
        const f = byId.get(a.id);
        if (!f) return;
        const dLane = lane < 0 ? 0 : lane - f.lane;
        if (!moveClips(p, engine, d.ids, a.start + dt - f.c.start, dLane) && dLane !== 0) {
          // A lane in the group's way is not an Audio lane (or is full): time only.
          moveClips(p, engine, d.ids, a.start + dt - f.c.start);
          flashHint('Audio clips move between audio tracks only');
        } else if (dLane !== 0) {
          // On another track now: select it, so the Clip tab follows the clip.
          const nf = byId.get(a.id);
          if (nf && isAudio(nf.c)) focusAudio(nf.t, nf.c);
        }
      });
    } else {
      const d = drag;
      const o = d.orig;
      const minLen = e.altKey ? 1 : Math.min(BEAT, o.len);
      let r: { start: number; len: number; offset: number };
      if (d.kind === 'right') {
        const end = o.start + o.len;
        let to = e.altKey ? end + dtRaw : snap(end + dtRaw, BEAT);
        const f = byId.get(o.id);
        // A one-shot audio clip's right edge stops at the end of its file (at the current tempo).
        if (f && isAudio(f.c)) to = Math.min(to, audioEdges(f.c, fileSeconds(p, f.c.sampleId), p.tempo).maxEnd);
        r = { start: o.start, len: resizeRight(o, to, minLen), offset: o.offset };
      } else {
        r = resizeLeft(o, e.altKey ? o.start + dtRaw : snap(o.start + dtRaw, BEAT), d.patLen, minLen);
        // An audio clip's offset is seconds: the trim moves it with the start (resizeClip({start}) would move the clip).
        if (byId.get(o.id)?.t.kind === 'audio') {
          const start = r.start;
          if (`${start}` === d.last) return;
          d.last = `${start}`;
          schedule(() => trimAudioClipStart(p, engine, o.id, start));
          return;
        }
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
    if (!p.tracks[clipLaneAt(layout, y)]) {
      cursor = 'default';
      return;
    }
    const hit = hitTest(boxes, x, y, v, layout);
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
      if (d.kind === 'move') { // audio clips moved to another lane go back first
        const f = byId.get(d.anchor.id);
        if (f && f.lane !== d.anchorLane) {
          moveClips(p, engine, d.ids, 0, d.anchorLane - f.lane);
          const nf = byId.get(d.anchor.id);
          if (nf && isAudio(nf.c)) focusAudio(nf.t, nf.c);
        }
      }
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
    const hit = hitTest(boxes, x, y, view, layout);
    const f = hit && byId.get(hit.id);
    if (!f) return;
    selectTrack(p, engine, f.t.id);
    if (isAudio(f.c)) { // its track's Clip tab, editing this clip
      clipFocus.id = f.c.id;
      p.mixerOpen = false;
      return;
    }
    selectPattern(p, engine, f.t.id, f.c.patternId);
    flashHint(`Editing ${f.t.name} · ${patNameOf(f.t, f.c)} below`);
  }

  function context(e: MouseEvent) {
    e.preventDefault(); // never the browser's menu over the lanes
    if (!view || drag) return;
    const { x, y } = local(e);
    const hit = hitTest(boxes, x, y, view, layout);
    const f = hit && byId.get(hit.id);
    if (!f) {
      menu = null;
      return;
    }
    if (!selected.has(f.c.id)) selected = new Set([f.c.id]);
    if (isAudio(f.c)) focusAudio(f.t, f.c);
    const t = xToTick(x, view);
    menu = { x: e.clientX, y: e.clientY, trackId: f.t.id, clipId: f.c.id, tick: e.altKey ? Math.round(t) : snap(t, BEAT) };
  }
  const menuClip = $derived(menu ? byId.get(menu.clipId) ?? null : null);
  /** "Make unique" only means something when another clip shares the pattern. */
  const menuShared = $derived(menuClip && 'patternId' in menuClip.c ? uses(menuClip.t, menuClip.c.patternId) > 1 : false);
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
  /** "Split here": the menu's clip (or the selection holding it) at the menu's tick. */
  function menuSplit() {
    if (menu) split(menuDeleteIds, menu.tick);
    closeMenu();
  }
  /** "Loop to fill" (a toggle): the file repeats until the clip ends; off, it plays once. */
  function menuLoop() {
    const c = menuClip?.c;
    if (c && isAudio(c)) setAudioClip(p, engine, c.id, { loop: !c.loop });
    closeMenu();
  }

  /**
   * Split `ids` at `tick` (song-actions splitClips: note and audio clips);
   * the right halves become the selection. Says so when no clip spans it.
   */
  function split(ids: string[], tick: number) {
    if (!ids.length) return flashHint('Select the clips to split (Cmd/Ctrl+E splits at the playhead)');
    const right = splitClips(p, engine, ids, tick);
    if (!right.length) return flashHint(`No selected clip spans the split point (${barRange(Math.round(tick), 1)})`);
    selected = new Set(right.map((c) => c.id));
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

  // ---- audio drops (see AUDIO LANES at the top) -----------------------------------
  /** Where a drag at client point `e` would land: its target and the drop tick. */
  function dropAt(e: DragEvent) {
    const v = view;
    if (!v || !lanesEl) return null;
    const { x, y } = local(e);
    const raw = Math.max(0, xToTick(Math.max(0, x), v));
    const tick = Math.min(MAX_SONG_TICKS - 1, e.altKey ? Math.round(raw) : snap(raw, BEAT));
    return { target: dropTarget(p.tracks, layout, y), tick };
  }

  function dragOver(e: DragEvent) {
    if (!isSampleDrag(e) || p.loading) return;
    e.preventDefault(); // accept it here (the window guard leaves a prevented drop alone)
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const at = dropAt(e);
    if (!at) return;
    const tg = at.target;
    const next = 'audioLane' in tg ? { lane: tg.audioLane } : 'newTrack' in tg ? 'new' as const : null;
    if (JSON.stringify(next) !== JSON.stringify(dropHover)) dropHover = next;
    if ('refused' in tg && hint !== DROP_HINT) flashHint(DROP_HINT);
  }
  function dragLeave(e: DragEvent) {
    // Leaving for a child of the scroll area is not leaving.
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) dropHover = null;
  }

  function drop(e: DragEvent) {
    if (!isSampleDrag(e)) return;
    e.preventDefault(); // handled here, whatever the target: never the window's "drop onto a row" error
    dropHover = null;
    if (p.loading) return;
    const at = dropAt(e);
    if (!at) return;
    const { target, tick } = at;
    if ('refused' in target) return flashHint(DROP_HINT);
    if ('newTrack' in target && tracksFull) return flashHint(FULL_TITLE);
    const trackId = 'audioLane' in target ? p.tracks[target.audioLane].id : null;
    const files = droppedFiles(e); // synchronously: the DataTransfer empties once this returns
    void placeDropped(files, trackId, tick);
  }

  /**
   * The drop's files, imported and placed by state/audioDrop.ts (one edit;
   * deferred loads registered as they land), then selected: the first clip
   * is the one the Clip tab shows.
   */
  async function placeDropped(pending: Promise<File[]>, trackId: string | null, start: number) {
    let files: File[];
    try {
      files = await pending;
    } catch (err) {
      banners.error = err instanceof Error ? err.message : String(err);
      return;
    }
    const r = await dropAudioFiles(p, engine, files, trackId, start);
    if (!r.track) {
      if (r.imported && trackId === null && p.tracks.length >= MAX_TRACKS) flashHint(FULL_TITLE);
      else if (r.imported && trackId !== null && !p.tracks.some((t) => t.id === trackId)) flashHint('The track was removed — files not placed');
      return;
    }
    if (r.placed.length) {
      selected = new Set(r.placed.map((c) => c.id));
      focusAudio(r.track, r.placed[0]);
      p.mixerOpen = false;
    }
    if (r.placed.length < r.imported) flashHint('Some files did not fit (song end or 256 clips per track)');
  }

  // ---- "+ Sampler track": a sample dropped on the button makes the track ------
  let samplerOver = $state(false);
  function samplerDragOver(e: DragEvent) {
    if (!isSampleDrag(e) || p.loading || tracksFull) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    samplerOver = true;
  }
  function samplerDrop(e: DragEvent) {
    if (!isSampleDrag(e)) return;
    e.preventDefault(); // handled here, never the window's "drop onto a row" error
    e.stopPropagation();
    samplerOver = false;
    if (p.loading || tracksFull) return;
    const pending = droppedFiles(e); // synchronously: the DataTransfer empties once this returns
    void (async () => {
      let files: File[];
      try {
        files = await pending;
      } catch (err) {
        banners.error = err instanceof Error ? err.message : String(err);
        return;
      }
      if (files[0]) await addSamplerTrack(p, engine, files[0]);
    })();
  }

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
    } else if (e.code === 'KeyE' && cmd && !e.altKey && !e.shiftKey) {
      take();
      releaseHeldKeys();
      if (e.repeat || drag) return;
      // At the heard playhead while playing in Song mode, else the parked song position.
      split(sel, playTick !== null && p.playing && p.mode === 'song' ? Math.round(playTick) : p.songPosition);
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
          void p.peaksVersion; // peaks landed, a deferred load settled or failed
          void banners.notice;
          const state = isAudio(c) ? audioState(c, new Set(pendingSampleIds())) : null;
          return {
            c,
            name,
            peaks: isAudio(c) && c.sampleId !== null && !!p.sampleMeta.get(c.sampleId)?.peaks,
            state,
            left,
            width: Math.max(MIN_CLIP_W, c.len / v.ticksPerPx),
            label: `${t.name} · ${name} · ${barRange(c.start, c.len)}${state && state !== 'missing' ? ` · ${STATE_TEXT[state]}` : ''}`,
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
  <!-- Sample drops anywhere over the timeline (AUDIO LANES at the top). -->
  <div class="scroll" bind:this={scrollEl} role="presentation" ondragenter={dragOver} ondragover={dragOver} ondragleave={dragLeave} ondrop={drop}>
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
      <TrackHeaders {p} {engine} rows={layout} />
      <!-- Focusable so the timeline keys (KEYBOARD FOCUS RULE) reach it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="lanes"
        bind:this={lanesEl}
        style:height="{lanesH}px"
        style:cursor
        tabindex="0"
        role="application"
        aria-label="Song arrangement. Click a lane to place its pattern, drop audio files on it; Delete removes, Cmd+D duplicates, Cmd+E splits, arrows nudge."
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
        <canvas bind:this={canvas} class="lanes-cv" data-testid="tl-canvas"></canvas>
        <canvas bind:this={ovCanvas} class="lanes-cv ov" data-testid="tl-playhead-canvas" aria-hidden="true"></canvas>
        {#each overlays as o, lane (o.t.id)}
          <div class="lane" data-testid="tl-lane-{o.t.slot}" style:top="{clipY[lane] ?? 0}px" title="{o.t.name}: {isPatternTrack(o.t) ? `click to place ${currentPattern(o.t).name}` : 'drop audio files here'}">
            {#each o.clips as k (k.c.id)}
              {#if 'sampleId' in k.c}
                {@const a = k.c}
                <!-- Audio clip: data-* mirror the model for tests; data-peaks once its waveform can be drawn. -->
                <div
                  class="clip"
                  data-testid="clip-{o.t.slot}-{a.idx}"
                  data-kind="audio"
                  data-start={a.start}
                  data-len={a.len}
                  data-offset={a.offset}
                  data-pattern={k.name}
                  data-loop={a.loop}
                  data-gain={a.gain}
                  data-peaks={k.peaks ? 1 : 0}
                  data-state={k.state ?? ''}
                  data-selected={selected.has(a.id)}
                  aria-label={k.label}
                  title="{k.label} — drag to move (also onto another audio track), edges trim, double-click for the Clip tab, right-click for more"
                  style:left="{k.left}px"
                  style:width="{k.width}px"
                ></div>
              {:else}
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
              {/if}
            {/each}
          </div>
        {/each}
        <!-- Automation lane rows (AutoLane: own canvas, pointer and keys) and the Master row's own row. -->
        {#each autoRows as a ('empty' in a ? `new-${a.row.trackId}` : a.lane.id)}
          {#if 'empty' in a}
            <div class="lane auto-empty" style:top="{a.row.y}px" style:height="{AUTO_H}px">Choose what to automate with + Lane on the left</div>
          {:else if view}
            <AutoLane
              {p} {engine} lane={a.lane} owner={a.owner} def={a.def} color={a.color} {view} {width} {dpr} top={a.row.y}
              testid="auto-lane-{a.key}-{a.k}" label={a.label} suspended={laneView.suspended.has(a.lane.id)} root={scrollEl} onhint={flashHint}
            />
          {/if}
        {/each}
        {#each layout.filter((r) => r.kind === 'master') as r (r.trackId)}
          <div class="lane master-row" data-testid="tl-master-row" style:top="{r.y}px">Master row: lanes for the master and the returns (A)</div>
        {/each}
      </div>
      <!-- Below the last lane: a drop here makes a new Audio track (tlMath.dropTarget). -->
      <div class="below" class:over={dropHover === 'new'} data-testid="tl-below">
        <span>{tracksFull ? FULL_TITLE : 'Drop audio files here for a new audio track'}</span>
      </div>
    </div>
    <div class="foot">
      <!-- Disabled at MAX_TRACKS (the engine has 32 slots), with a reason. -->
      <button data-testid="add-drum-track" disabled={tracksFull} title={tracksFull ? FULL_TITLE : 'Add a drum track'} onclick={() => addDrumTrack(p, engine)}>+ Drum track</button>
      <button data-testid="add-synth-track" disabled={tracksFull} title={tracksFull ? FULL_TITLE : 'Add a synth track (Deep Bass)'} onclick={() => addSynthTrack(p, engine, undefined, deepBass)}>+ Synth track</button>
      <button
        data-testid="add-sampler-track" class:over={samplerOver} disabled={tracksFull}
        title={tracksFull ? FULL_TITLE : 'Add a sampler track: drop a sample here or on its Sample Player'}
        onclick={() => { if (!tracksFull) void addSamplerTrack(p, engine); }}
        ondragover={samplerDragOver} ondragleave={() => (samplerOver = false)} ondrop={samplerDrop}
      >+ Sampler track</button>
      {#if !p.mixer.automation.length}
        <!-- The Master row (automation of the master and the returns); it stays once it has a lane. -->
        <button
          data-testid="tl-master-toggle" aria-pressed={laneView.master}
          title={laneView.master ? 'Hide the Master row' : 'Show the Master row: automation lanes for the master, reverb and delay'}
          onclick={() => { laneView.master = !laneView.master; if (laneView.master) setOpen(MASTER_ROW, true); }}
        >{laneView.master ? '− Master row' : '+ Master row'}</button>
      {/if}
      <button data-testid="add-audio-track" disabled={tracksFull} title={tracksFull ? FULL_TITLE : 'Add an audio track: drop audio files on its lane'} onclick={() => { if (addAudioTrack(p, engine)) p.mixerOpen = false; }}>+ Audio track</button>
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
      {#if !isAudio(menuClip.c)}
        <button
          role="menuitem"
          data-testid="tl-menu-unique"
          disabled={!menuShared}
          title={menuShared ? 'Give this clip its own copy of the pattern' : 'Only this clip uses this pattern'}
          onclick={menuUnique}
        >Make unique</button>
      {/if}
      <button role="menuitem" data-testid="tl-menu-split" title="Split at this beat (Cmd/Ctrl+E splits at the playhead)" onclick={menuSplit}>
        Split here{menuDeleteIds.length > 1 ? ` (${menuDeleteIds.length} clips)` : ''}
      </button>
      {#if isAudio(menuClip.c)}
        <button
          role="menuitemcheckbox"
          aria-checked={menuClip.c.loop}
          data-testid="tl-menu-loop"
          title="Loop to fill: the file repeats until the clip ends (off: it plays once and its right edge stops at the file's end)"
          onclick={menuLoop}
        ><span class="check" aria-hidden="true">{menuClip.c.loop ? '✓' : ''}</span>Loop to fill</button>
      {/if}
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
  .lanes-cv.ov { pointer-events: none; z-index: 1; }
  .lane { position: absolute; left: 0; right: 0; height: var(--lane-h); }
  .clip { position: absolute; top: 2px; height: 23px; }
  .auto-empty, .master-row { display: flex; align-items: center; padding-left: 8px; font-size: 10px; color: #5d606b; pointer-events: none; }
  .below { grid-column: 1 / -1; min-height: calc(var(--lane-h) * 2); display: flex; align-items: center; justify-content: center; border-top: 1px dashed transparent; color: #4d505b; font-size: 11px; }
  .below.over { background: rgba(240, 162, 58, 0.12); border-top-color: #f0a23a; color: #ffd98a; }
  .menu .check { display: inline-block; width: 14px; }
  .foot { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: #1b1c21; border-top: 1px solid #2a2c33; }
  .foot button { font: inherit; font-size: 11px; padding: 2px 8px; border: 1px solid #3a3d48; border-radius: 3px; background: #24262c; color: #c9cbd3; cursor: pointer; white-space: nowrap; }
  .foot button:hover { background: #2e313a; }
  .foot button.over { border-color: #f0a23a; background: #2e313a; }
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
