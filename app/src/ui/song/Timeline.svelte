<script lang="ts">
  // Song timeline (the top-centre Song pane, layout B). Replaces the plan-2
  // track list: the track headers are its left column.
  //
  // Layout: one vertical scroll container (native scrolling, so headers and
  // lanes stay aligned when many tracks exist):
  //   corner "TRACKS" +    | ruler canvas (sticky top), two rows (RULER below):
  //     "Bar" / "Time"     |   BAR (bar numbers, beats, loop) over TIME (m:ss)
  //   track headers (HTML) | lanes: canvas (grid, loop shading, clips, playhead)
  //                        |        + transparent DOM overlays per lane / clip
  //   drop zone below the last lane (`tl-below`): drop audio for a new track
  //   footer (sticky bottom): + Add track (AddTrackMenu), time scrollbar, status
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
  // LOOK (plan 20, spec §4 Playlist). Every canvas colour is a theme token
  // read from ui/theme.ts (clipDraw.CANVAS, `C` here); shades between tokens
  // are a token under a white or black veil. The clip drawing itself lives in
  // clipDraw.ts: a rounded body in the track colour with the --gloss recipe
  // drawn on canvas (drawBody: a white 30 % -> 0 gradient over the top 60 %,
  // a 1 px top highlight, a 2 px darker bottom edge), its name in
  // --on-color, and a mini preview of what it plays in --on-color:
  //   - drum pattern: a mark per hit, one band per row that has hits;
  //   - synth pattern: a dash per note at its pitch;
  //   - audio: the waveform from the sample's peaks (drawAudio).
  // A missing / failed sample's clip is dark (--well) with a --rec hatch and
  // a light name. Preview cost stays bounded: the marks are computed once
  // per pattern content (`previews`, a $derived: a scroll or zoom does not
  // recompute them), only visible clips draw, only the pattern periods in
  // view are placed (tlMath.periodStarts), and a period narrower than
  // clipDraw.BITMAP_MAX_PX is rendered once into a cached bitmap per pattern
  // and zoom (PreviewCache) and stamped, so a zoomed-out song is one
  // drawImage per period. Below PREVIEW_MIN_PX per period there is no
  // preview. The selection is a light outline with resize grips. The loop
  // range is an --accent bar on the ruler (dim while the loop is off or in
  // Pattern mode) over a faint band; the playhead is white (--text) with a
  // soft glow.
  //
  // RULER (plan 21 §6: "what of it is time?"). Two labelled rows (tlMath
  // RULER_BAR_H / RULER_TIME_H; the corner cell names them "Bar" / "Time"):
  //   - BAR: a line and the bar number every barLabelStep bars, beat ticks
  //     along its bottom when beats are >= 8 px; the loop bar along its top,
  //     with a "Loop" tab at the range's right end once the range is
  //     LOOP_LABEL_MIN_PX wide on screen; the playhead head (a downward
  //     triangle in the playhead colour, dim for the parked position);
  //   - TIME (a shade darker): m:ss labels every timeLabelStep seconds
  //     (1/2/5/10/15/30 s, 1/2/5… min; >= 48 px apart), placed at the tick
  //     where that second falls at p.tempo (one tempo per project).
  // The canvas mirrors the TIME labels in `data-time-labels` (tests can't
  // read canvas text). HOVER READOUT: over the lanes and the ruler a small
  // chip by the pointer says where it is, "Bar 5.3 · 0:09.4" (tlMath
  // posReadout; `tl-hover-readout`). It hides while a button is held (a clip,
  // point or loop drag), and when the pointer leaves. It listens in the
  // capture phase on the lanes because AutoLane stops its pointermove.
  // EMPTY STATE: with tracks but no clip at all, the lanes say how to start
  // (`tl-empty-hint`).
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
  // bottom panel's Clip tab (ClipPanel.svelte, Alt+6) edits it (clipFocus).
  //
  // AUTOMATION (plan 10; spec addendum §3.4). Rows are not uniform: the
  // layout map (tlMath.rowLayout) stacks, under each track's clip row
  // (LANE_H), its automation lanes while the track is open (its header's A;
  // laneView.open, UI state; each lane AUTO_H tall unless its header's grab
  // strip resized it: laneView.heights, plan 19), and pins the Master row (the
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
  // toggles the transport.
  import { onDestroy, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import { TRACKS_FULL_TEXT, selectTrack } from '../../state/actions';
  import type { ImportEngine } from '../../state/sampleImport';
  import { dropAudioFiles } from '../../state/audioDrop';
  import { pendingSampleIds, sampleFailed } from '../../state/sampleLoads';
  import { banners } from '../../state/banners.svelte';
  import { droppedFiles, isSampleDrag } from '../../library/drag';
  import { clipFocus, sampleName } from './clipFocus.svelte';
  import type { AudioClock } from '../../audio/audioClock';
  import type { AudioClip, AutomationLane, Clip, Project, Track } from '../../state/project.svelte';
  import type { AutoOwner } from '../../state/automation';
  import { MAX_TRACKS, currentPattern, isPatternTrack, patternLength } from '../../state/project.svelte';
  import { RADII, THEME } from '../theme';
  import { rangeFill } from '../rangeFill';
  import { patternOf, selectPattern } from '../../state/pattern-actions';
  import {
    deleteClips, duplicateClips, makeUnique, moveClips, resizeClip, seek, setLoop, addClip, splitClips, transportPlaying,
  } from '../../state/song-actions';
  import { fileSeconds, setAudioClip, trimAudioClipStart } from '../../state/audio-actions';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { MAX_SONG_TICKS } from '../../audio/protocol';
  import TrackHeaders from './TrackHeaders.svelte';
  import AutoLane from './AutoLane.svelte';
  import AddTrackMenu from './AddTrackMenu.svelte';
  import { laneHeight, laneView } from './laneView.svelte';
  import { targetLabel } from './autoLabels';
  import { targetDef } from '../../state/automation';
  import {
    BAR, BEAT, HEADER_W, LANE_H, LOOP_LABEL_MIN_PX, MASTER_GREY, MIN_CLIP_W, RULER_BAR_H, RULER_H, RULER_TIME_H, ZOOM, audioEdges,
    barLabelStep, barRange, posReadout, timeLabels, boxSelect, clampGroupDt, clipLaneAt, dropTarget, drumPreview, followPage, hitTest, loopFromDrag,
    notePreview, placeLen, repeatTicks, resizeLeft, resizeRight, rowLayout, rowsHeight, seekTick, snap, snapFloor, tickToX,
    xToTick, zoomAt,
  } from './tlMath';
  import type { ClipBox, PreviewMark, TlView } from './tlMath';
  import { CANVAS as C, PreviewCache, drawAudio, drawBody, drawPreview, drawRepeats, veil } from './clipDraw';
  import type { AudioState } from './clipDraw';

  let { p, engine, clock }: { p: Project; engine: CommandSink & ImportEngine; clock: AudioClock | null } = $props();

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
  /**
   * The hover readout (RULER at the top): the pointer in .tl px (the chip
   * sits right of it; `flip`: near the right edge, left of it) and
   * in lanes x (what it reads: a time scroll or zoom under a still pointer
   * updates the text, since it is derived from the view).
   */
  let pointer = $state.raw<{ x: number; y: number; flip: boolean; laneX: number } | null>(null);
  const hoverText = $derived(pointer && view ? posReadout(xToTick(pointer.laneX, view), p.tempo) : '');

  type Found = { t: Track; c: Clip | AudioClip; lane: number };
  // The layout map (see AUTOMATION at the top): every row's y and height.
  /** The Master row shows once it has a lane, or when asked for (footer, Task 4's "Automate"). */
  const masterShown = $derived(p.mixer.automation.length > 0 || laneView.master);
  // Once the Master row has a lane (added, loaded, undone back) it was asked
  // for: removing its last lane later keeps the row (its × hides it).
  $effect(() => {
    if (p.mixer.automation.length > 0) untrack(() => (laneView.master = true));
  });
  const layout = $derived(rowLayout(p.tracks, laneView.open, masterShown ? p.mixer.automation.map((x) => x.lane) : null, laneHeight));
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
        return `${t.name} · ${patNameOf(t, c)} · ${barRange(c.start, c.len)}${c.loop ? ' · loop' : ''}${file} · Alt+6 edits gain and fades`;
      }
      const reps = c.len / patLenOf(t, c);
      const times = Number.isInteger(reps) ? `×${reps}` : `×${reps.toFixed(2)}`;
      const pc = patternClip(t, c);
      const inEditor = !pc || (p.selectedTrackId === t.id && pc.t.currentPatternId === pc.c.patternId);
      return `${t.name} · ${patNameOf(t, c)} · ${barRange(c.start, c.len)} · ${times}${inEditor ? '' : ' · double-click to edit'}`;
    }
    if (sel.length > 1) return `${sel.length} clips selected`;
    if (patternRunning() && byId.size) return 'The pattern transport is playing: play the song (top bar) to hear the clips';
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

  // The playlist is the song's view: with the PAT/SONG switch gone (plan 20)
  // the hidden `p.mode` (which transport ran last) must not change it while
  // stopped. Stopped, it is drawn as Song (the loop range live, the parked
  // song position shown: the next Song Play starts there); only while the
  // pattern transport actually plays do the pattern-specific visuals show.
  /** True while the pattern transport plays (the song is not heard). */
  const patternRunning = () => transportPlaying(p, 'pattern');
  /** The loop range counts (bright) while on, unless the pattern transport plays; otherwise it is shown dimmed. */
  const loopLive = () => p.loop.on && !patternRunning();

  function sizeCanvas(cv: HTMLCanvasElement, w: number, h: number) {
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = cv.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /** Song marker: the heard playhead while the song plays, else the parked song position (dim); none while the pattern transport plays. */
  function marker(): { t: number; live: boolean } | null {
    if (patternRunning()) return null;
    if (playTick !== null) return { t: playTick, live: true };
    return p.playing ? null : { t: p.songPosition, live: false };
  }

  // ---- clip previews (LOOK at the top; the drawing is clipDraw.ts) ----------------
  /** Each pattern's preview bitmap, by pattern id (clipDraw.PreviewCache). */
  const previewCache = new PreviewCache();
  /**
   * Each used pattern's preview marks by pattern id (tlMath drumPreview /
   * notePreview), normalised to one period. A $derived: Svelte recomputes it
   * when a used pattern's steps or notes change, never on a scroll or zoom.
   * Only patterns a clip uses are computed.
   */
  const previews = $derived.by(() => {
    const m = new Map<string, { marks: PreviewMark[]; drum: boolean }>();
    for (const t of p.tracks) {
      if (t.kind === 'audio') continue;
      for (const c of t.clips) {
        if (m.has(c.patternId)) continue;
        const pat = patternOf(t, c.patternId);
        if (!pat) continue;
        if ('stepCount' in pat) m.set(pat.id, { marks: drumPreview(pat.steps, t.kind === 'drum' ? t.rows.length : 0, pat.stepCount), drum: true });
        else m.set(pat.id, { marks: notePreview(pat.notes, pat.bars), drum: false });
      }
    }
    return m;
  });
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
      ctx.fillStyle = C.lane;
      ctx.fillRect(0, r.y, W, r.h);
      // The selected track's row a shade lighter; lane rows (AutoLane draws the curve on its own canvas) and the Master row darker.
      const shade = r.kind === 'clips' ? (r.trackId === p.selectedTrackId ? veil(true, 0.06) : null) : veil(false, r.kind === 'master' ? 0.06 : 0.1);
      if (shade) {
        ctx.fillStyle = shade;
        ctx.fillRect(0, r.y, W, r.h);
      }
      ctx.fillStyle = C.sep;
      ctx.fillRect(0, r.y + r.h - 1, W, 1);
    }
    const vline = (t: number, style: string) => {
      ctx.fillStyle = style;
      ctx.fillRect(Math.round(tickToX(t, v)), 0, 1, H);
    };
    if (BEAT / v.ticksPerPx >= 8) for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) if (t % BAR) vline(t, C.sep);
    const step = barLabelStep(v.ticksPerPx);
    for (let t = snapFloor(t0, BAR); t <= t1; t += BAR) {
      const bar = t / BAR;
      if (bar % step === 0 || BAR / v.ticksPerPx >= 6) vline(t, bar % 4 === 0 ? C.bar4 : C.bar);
    }

    // loop range: faint over the lanes (dimmer while not live)
    const lx0 = tickToX(p.loop.start, v);
    const lx1 = tickToX(p.loop.end, v);
    if (lx1 > 0 && lx0 < W) {
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = loopLive() ? 0.07 : 0.025;
      ctx.fillRect(lx0, 0, lx1 - lx0, H);
      ctx.globalAlpha = 1;
    }

    // Audio lanes redraw when peaks land (peaksVersion) and when a deferred
    // load settles (the "will load when playback stops" notice clears then).
    void p.peaksVersion;
    void banners.notice;
    const pending = new Set(pendingSampleIds());

    // A sample drag over an audio lane: that lane lights up.
    if (dropHover && dropHover !== 'new') {
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(0, clipY[dropHover.lane] ?? 0, W, LANE_H - 1);
      ctx.globalAlpha = 1;
    }

    // Bitmaps of patterns no clip uses any more go.
    previewCache.prune((id) => previews.has(id));

    // clips (unselected first; the selection on top)
    ctx.font = `700 10px ${THEME.fontUi}`;
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
      const st = isAudio(c) ? audioState(c, pending) : null;
      const broken = st === 'missing' || st === 'failed';
      // The body, cut to the view (+ a corner's width): a clip far wider than the view costs no more than the view.
      const rad = Math.min(RADII.sm, w / 2, h / 2);
      const bx0 = Math.max(x0, -rad - 1);
      const bx1 = Math.min(x1, W + rad + 1);
      const body = new Path2D();
      body.roundRect(bx0, y, bx1 - bx0, h, rad);
      ctx.save();
      ctx.clip(body);
      drawBody(ctx, broken ? C.broken : t.color, bx0, y, bx1 - bx0, h);
      if (isAudio(c)) {
        const meta = c.sampleId !== null ? p.sampleMeta.get(c.sampleId) : undefined;
        drawAudio(ctx, c, meta, p.tempo, x0, x1, y, h, v, W, pending.has(c.sampleId ?? -1), st);
      } else {
        const pat = isPatternTrack(t) ? patternOf(t, c.patternId) : null;
        const pv = pat && previews.get(pat.id);
        if (pat && pv) drawPreview(ctx, { patternId: pat.id, ...pv, patLen: patternLength(pat), start: c.start, len: c.len, offset: c.offset }, y, h, v, W, dpr, previewCache);
        drawRepeats(ctx, repeatTicks(c.start, c.len, c.offset, patLenOf(t, c)), x0, x1, y, h, v);
      }
      if (w > 18) { // the name, pinned to the left edge while scrolled
        const name = patNameOf(t, c) + (st === 'failed' ? ' · sample failed to load' : '');
        const lx = Math.max(x0, 0) + 5;
        if (isAudio(c)) { // over the waveform: on a backing in the body colour
          ctx.fillStyle = broken ? C.broken : t.color;
          ctx.globalAlpha = broken ? 1 : 0.85;
          ctx.fillRect(lx - 3, y + 2, ctx.measureText(name).width + 6, 12);
          ctx.globalAlpha = 1;
        }
        // A broken clip's body is dark: its name is light (--text on --well).
        ctx.fillStyle = broken ? C.brokenText : C.onColor;
        ctx.fillText(name, lx, y + 3);
      }
      ctx.restore();
      ctx.lineWidth = isSel ? 1.5 : 1;
      ctx.strokeStyle = isSel ? C.playhead : veil(false, 0.35);
      ctx.beginPath();
      ctx.roundRect(bx0 + 0.5, y + 0.5, Math.max(1, bx1 - bx0 - 1), h - 1, rad);
      ctx.stroke();
      if (isSel && w > 14) { // resize grips
        ctx.fillStyle = C.playhead;
        ctx.fillRect(x0 + 2, y + 7, 1.5, h - 11);
        ctx.fillRect(x1 - 3.5, y + 7, 1.5, h - 11);
      }
    }

    if (box) {
      const bx = Math.min(box.x0, box.x1);
      const by = Math.min(box.y0, box.y1);
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }
  }

  /**
   * The playhead / parked position over the lanes, on its own transparent
   * canvas on top: while playing only this (and the ruler) is redrawn every
   * frame, never the lanes and their waveforms. The playhead is white with a
   * soft glow; the parked position a dim line without one.
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
      const x = Math.round(tickToX(m.t, v));
      if (x >= -1 && x <= W + 1) {
        ctx.fillStyle = C.playhead;
        if (m.live) {
          ctx.shadowColor = veil(true, 0.6);
          ctx.shadowBlur = 6 * dpr; // device px: the canvas transform does not scale shadows
          ctx.fillRect(x - 1, 0, 2, H);
          ctx.shadowBlur = 0;
          ctx.shadowColor = 'transparent';
        } else {
          ctx.globalAlpha = 0.4;
          ctx.fillRect(x - 0.75, 0, 1.5, H);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  /**
   * What is wrong with an audio clip's sample, if anything: `missing` (none:
   * not in the project folder), `failed` (its deferred load failed:
   * sampleLoads.sampleFailed; it plays nothing), `pending` (its deferred
   * load waits for Stop). Drawn hatched (the first two in --rec on a grey
   * body), and said in the overlay's aria-label and data-state.
   */
  function audioState(c: AudioClip, pending: ReadonlySet<number>): AudioState {
    if (c.sampleId === null) return 'missing';
    if (sampleFailed(c.sampleId)) return 'failed';
    return pending.has(c.sampleId) ? 'pending' : null;
  }
  const STATE_TEXT = { missing: 'missing sample', failed: 'sample failed to load: stop and drop it again', pending: 'loads when playback stops' };

  /** The two ruler rows (RULER at the top); `data-time-labels` mirrors the TIME row for tests. */
  function drawRuler() {
    const cv = rulerCv;
    const v = view;
    const W = width;
    if (!cv || !v || W <= 0) return;
    const ctx = sizeCanvas(cv, W, RULER_H);
    if (!ctx) return;
    const t0 = xToTick(0, v);
    const t1 = xToTick(W, v);
    const TY = RULER_BAR_H; // the TIME row's top
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.fillStyle = veil(false, 0.14); // TIME a shade darker, so the rows read as two
    ctx.fillRect(0, TY, W, RULER_TIME_H);
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, TY, W, 1);

    // Loop range: a faint band over both rows and the --accent bar along the top (bright while live, dim otherwise).
    const lx0 = tickToX(p.loop.start, v);
    const lx1 = tickToX(p.loop.end, v);
    const live = loopLive();
    if (lx1 > 0 && lx0 < W) {
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = live ? 0.16 : 0.05;
      ctx.fillRect(lx0, 0, lx1 - lx0, RULER_H);
      ctx.globalAlpha = live ? 0.9 : 0.35;
      const bx0 = Math.max(lx0, -4);
      ctx.beginPath();
      ctx.roundRect(bx0, 0, Math.min(lx1, W + 4) - bx0, 6, [0, 0, 3, 3]);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // BAR row: beat ticks, then a line and the number at every labelled bar.
    ctx.textBaseline = 'middle';
    if (BEAT / v.ticksPerPx >= 8) {
      ctx.fillStyle = C.bar;
      for (let t = snapFloor(t0, BEAT); t <= t1; t += BEAT) if (t % BAR) ctx.fillRect(Math.round(tickToX(t, v)), TY - 5, 1, 5);
    }
    const step = barLabelStep(v.ticksPerPx);
    ctx.font = `500 10px ${THEME.fontMono}`;
    for (let t = snapFloor(t0, BAR * step); t <= t1; t += BAR * step) {
      const x = Math.round(tickToX(t, v));
      ctx.fillStyle = C.bar4;
      ctx.fillRect(x, 0, 1, TY);
      ctx.fillStyle = C.rulerText;
      ctx.fillText(String(t / BAR + 1), x + 4, TY / 2 + 2);
    }

    // TIME row: a tick and m:ss at every label.
    const labels = timeLabels(Math.max(0, t0), t1, v.ticksPerPx, p.tempo);
    ctx.font = `500 9px ${THEME.fontMono}`;
    for (const l of labels) {
      const x = Math.round(tickToX(l.t, v));
      ctx.fillStyle = C.bar4;
      ctx.fillRect(x, TY, 1, RULER_TIME_H);
      ctx.fillStyle = C.rulerText;
      ctx.fillText(l.text, x + 3, TY + RULER_TIME_H / 2 + 1);
    }
    cv.dataset.timeLabels = labels.map((l) => l.text).join(' ');

    // "Loop": a tab hanging from the loop bar at the range's right end (pinned
    // to the view's edge while that end is off screen), drawn over the bar
    // numbers, once the range is wide enough on screen.
    const tabR = Math.min(lx1, W);
    const loopLabel = tabR - Math.max(lx0, 0) >= LOOP_LABEL_MIN_PX;
    if (loopLabel) {
      ctx.font = `700 9px ${THEME.fontUi}`;
      const tw = ctx.measureText('Loop').width + 8;
      ctx.fillStyle = C.accent;
      ctx.globalAlpha = live ? 0.9 : 0.35;
      ctx.beginPath();
      ctx.roundRect(tabR - tw - 2, 0, tw, 12, [0, 0, 3, 3]);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = live ? C.onColor : C.rulerText; // a dim tab is mostly the ruler: light text reads there
      ctx.fillText('Loop', tabR - tw + 2, 6.5);
    }
    cv.dataset.loopLabel = loopLabel ? '1' : '0';

    // The playhead head: a downward triangle on the BAR row, its line through both rows.
    const m = marker();
    if (m) {
      const x = tickToX(m.t, v);
      if (x >= -6 && x <= W + 6) {
        ctx.fillStyle = C.playhead;
        ctx.globalAlpha = m.live ? 1 : 0.55;
        ctx.beginPath();
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, 9);
        ctx.fill();
        ctx.fillRect(Math.round(x) - 1, 0, 2, RULER_H);
        ctx.globalAlpha = 1;
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
      else if (p.selectedTrackId !== hf.t.id) selectTrack(p, engine, hf.t.id); // a note clip selects its track too
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
      // While the pattern transport plays the engine ignores the song position until the song transport plays.
      if (patternRunning()) flashHint(`Song position set to bar ${Math.floor(p.songPosition / BAR) + 1} — play the song (top bar) from here`);
    }
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

  // ---- hover readout (RULER at the top) ------------------------------------------
  /** Pointer moves over the lanes (capture: AutoLane stops its own) and the ruler; none while a button is held (a drag). */
  function readoutMove(e: PointerEvent) {
    if (!lanesEl || !root || e.buttons || drag || laneView.gesture) {
      pointer = null;
      return;
    }
    const r = root.getBoundingClientRect();
    const x = e.clientX - r.left;
    pointer = { x, y: e.clientY - r.top, flip: x > r.width - 150, laneX: e.clientX - lanesEl.getBoundingClientRect().left };
  }
  const readoutLeave = () => (pointer = null);

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
  style:--ruler-bar-h="{RULER_BAR_H}px"
  style:--lane-h="{LANE_H}px"
>
  <!-- Sample drops anywhere over the timeline (AUDIO LANES at the top). -->
  <div class="scroll" bind:this={scrollEl} role="presentation" ondragenter={dragOver} ondragover={dragOver} ondragleave={dragLeave} ondrop={drop}>
    <div class="grid">
      <!-- The header column's top-left cell: what the column is, and the two ruler rows' names beside them. -->
      <div class="corner" data-testid="tl-corner">
        <span class="lbl">Tracks</span>
        <span class="row-lbl bar-lbl">Bar</span>
        <span class="row-lbl time-lbl">Time</span>
      </div>
      <div class="ruler-wrap">
        <canvas
          bind:this={rulerCv}
          class="ruler"
          data-testid="tl-ruler"
          aria-label="Ruler: click to set the song position, drag to set the loop range (bars {Math.floor(p.loop.start / BAR) + 1}–{Math.ceil(p.loop.end / BAR)}{p.loop.on ? ', loop on' : ', loop off'})"
          data-loop="{p.loop.start},{p.loop.end},{p.loop.on ? 1 : 0}"
          data-loop-live={loopLive() ? 1 : 0}
          data-marker={patternRunning() ? 'none' : p.playing ? 'live' : 'parked'}
          title="Click: set the song position (Alt: exact). Drag: set the loop range."
          onpointerdown={rulerDown}
          onpointermove={(e) => { readoutMove(e); rulerMove(e); }}
          onpointerleave={readoutLeave}
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
        onpointermovecapture={readoutMove}
        onpointerup={up}
        onpointercancel={cancel}
        onlostpointercapture={cancel}
        onpointerleave={() => { readoutLeave(); if (!drag) cursor = 'default'; }}
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
            <div class="lane auto-empty" style:top="{a.row.y}px" style:height="{a.row.h}px">Choose what to automate with Automate… on the left</div>
          {:else if view}
            <AutoLane
              {p} {engine} lane={a.lane} owner={a.owner} def={a.def} color={a.color} {view} {width} {dpr} top={a.row.y} h={a.row.h}
              testid="auto-lane-{a.key}-{a.k}" label={a.label} suspended={laneView.suspended.has(a.lane.id)} root={scrollEl} onhint={flashHint}
            />
          {/if}
        {/each}
        {#each layout.filter((r) => r.kind === 'master') as r (r.trackId)}
          <div class="lane master-row" data-testid="tl-master-row" style:top="{r.y}px">Master row: lanes for the master and the returns (A)</div>
        {/each}
        {#if p.tracks.length && !byId.size}
          <div class="empty-hint" data-testid="tl-empty-hint">Drag a pattern from a track, or click a lane to place its current pattern</div>
        {/if}
      </div>
      <!-- Below the last lane: a drop here makes a new Audio track (tlMath.dropTarget). -->
      <div class="below" class:over={dropHover === 'new'} data-testid="tl-below">
        <span>{tracksFull ? FULL_TITLE : 'Drop audio files here for a new audio track'}</span>
      </div>
    </div>
    <div class="foot">
      <!-- One "+ Add track" list (its items are disabled at MAX_TRACKS, with the reason); a sample dropped on it makes a Sampler track. -->
      <AddTrackMenu {p} {engine} onhint={flashHint} />
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
        style:--fill={rangeFill(view ? view.scrollTick / Math.max(1, MAX_SONG_TICKS - width * view.ticksPerPx) : 0).fill}
        oninput={(e) => { if (view) view = clampView({ ...view, scrollTick: Number(e.currentTarget.value) }); }}
      />
      <output class="readout" class:hint={!!hint} data-testid="tl-readout">{readoutText}</output>
    </div>
  </div>
  {#if pointer && hoverText}
    <div class="hover-readout" class:flip={pointer.flip} data-testid="tl-hover-readout" aria-hidden="true" style:left="{pointer.x}px" style:top="{pointer.y}px">{hoverText}</div>
  {/if}
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
  /* Tokens only (theme.css); the canvases read the same values from ui/theme.ts. */
  .tl { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; height: 100%; background: var(--work); }
  .scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column; }
  .grid { display: grid; grid-template-columns: var(--header-w) minmax(0, 1fr); flex: 1 0 auto; align-content: start; }
  .corner, .ruler-wrap { position: sticky; top: 0; z-index: 2; height: var(--ruler-h); background: var(--panel); border-bottom: 1px solid var(--line); }
  /* "TRACKS" on the left; "Bar" / "Time" on the right, each centred on its ruler row (RULER_BAR_H / RULER_TIME_H). */
  .corner { box-sizing: border-box; display: grid; grid-template-columns: 1fr auto; grid-template-rows: var(--ruler-bar-h) 1fr; align-items: center; padding: 0 8px 0 10px; border-right: 1px solid var(--line); }
  .corner .lbl { grid-row: 1 / -1; }
  .row-lbl { grid-column: 2; font: 500 var(--fs-xs) var(--font-ui); color: var(--text-2); text-align: right; }
  .bar-lbl { grid-row: 1; }
  .time-lbl { grid-row: 2; }
  .ruler-wrap { min-width: 0; }
  .ruler { display: block; width: 100%; height: var(--ruler-h); cursor: text; touch-action: none; }
  .lanes { position: relative; min-width: 0; overflow: hidden; outline: none; touch-action: none; background: var(--work); }
  .lanes:focus-visible { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent); }
  .lanes-cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .lanes-cv.ov { pointer-events: none; z-index: 1; }
  .lane { position: absolute; left: 0; right: 0; height: var(--lane-h); }
  .clip { position: absolute; top: 2px; height: 23px; }
  .empty-hint { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; padding: 0 12px; text-align: center; font-size: var(--fs-ctl); color: var(--text-2); pointer-events: none; }
  /*
   * The hover readout: a small chip right of the pointer, at its height (left of it near the right edge).
   * Beside, not under: the global tooltip of the lane / ruler opens below the element, so the two never overlap.
   */
  .hover-readout { position: absolute; z-index: 3; translate: 14px -50%; padding: 2px 6px; border-radius: var(--r-sm); background: var(--lcd); color: var(--text); font: 500 var(--fs-lbl)/14px var(--font-mono); white-space: nowrap; box-shadow: var(--lift); pointer-events: none; }
  .hover-readout.flip { translate: calc(-100% - 14px) -50%; }
  .auto-empty, .master-row { display: flex; align-items: center; padding-left: 8px; font-size: var(--fs-lbl); color: var(--text-2); pointer-events: none; }
  .below { grid-column: 1 / -1; min-height: calc(var(--lane-h) * 2); display: flex; align-items: center; justify-content: center; border-top: 1px dashed transparent; color: var(--text-2); font-size: 11px; opacity: 0.7; }
  .below.over { opacity: 1; background: color-mix(in srgb, var(--accent) 12%, transparent); border-top-color: var(--accent); color: var(--accent); }
  .menu .check { display: inline-block; width: 14px; }
  .foot { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--panel); border-top: 1px solid var(--line); }
  .hscroll { width: 140px; flex: none; margin-left: 8px; --c: var(--text-dim); }
  .readout { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/1.4 var(--font-ui); color: var(--text-2); }
  .readout.hint { color: var(--accent); }
  .menu { position: fixed; z-index: 50; min-width: 150px; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift); display: flex; flex-direction: column; }
  .menu-ttl { font-size: var(--fs-lbl); color: var(--text-2); padding: 2px 6px 4px; white-space: nowrap; }
  .menu button { font: inherit; text-align: left; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: var(--raised); outline: none; }
  .menu button:disabled { color: var(--text-2); opacity: 0.5; cursor: not-allowed; }
</style>
