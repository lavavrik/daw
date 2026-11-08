<script module lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { createSweepKeys } from '../../history/sweep';
  /**
   * Track ids whose rack was edited since its patch was loaded: drives the
   * "(edited)" marker next to the patch name. UI state only (not saved, not
   * in Project); module-level so it survives switching tracks/tabs.
   */
  const edited = new SvelteSet<string>();
  /**
   * Track id -> the patch-dropdown option its patch was last loaded or saved
   * from (library/patchSource.ts): tells a library "Pad" from the starter.
   */
  const loadedFrom = new SvelteMap<string, string>();
  /** Alt+arrow module nudges: `rackmove:<trackId>:<n>`, a new undo entry after 1 s idle (history/sweep.ts). */
  const sweepKey = createSweepKeys();
</script>

<script lang="ts">
  // The Instrument tab: a VCV-Rack-style rail of module panels, with cables
  // drawn on an SVG layer above them.
  //
  // Layout (docs/architecture/modular.md "Layout (plan 18)"): `.rail` is the
  // scroller; `.content` (position: relative) holds the panels AND the cable
  // <svg>, so cables scroll with the panels. Two modes:
  //   - flow (no module has a `pos`; plan 13): `.content` is a wrapping flex
  //     container the rail's width: panels by idx, left to right, wrapping
  //     into rows as tall as their tallest panel (align-items: stretch),
  //     rows 14 px apart;
  //   - positioned (any `pos`): `placed` = rackLayout.ts layoutRack(modules,
  //     measured widths); each panel is absolute at left = PAD + x·GRID, top =
  //     the sum of the rows above (each as tall as its tallest panel) + 14 px
  //     gaps, min-height = its row's height (jacks line up as in flow);
  //     `.content` gets an explicit width (>= 100 %) and height, so the rail
  //     scrolls both ways.
  // Measuring: measure() reads every panel's offsetWidth and NATURAL height
  // (offsetHeight minus its stretch spacer, so the row min-height never feeds
  // back) into `dims` (what the layout is derived from; a change re-measures
  // after the DOM update) and the jack centres relative to `.content`. It runs on patch
  // change, a layout change, scroll, and whenever the ResizeObserver sees
  // `.rail`, `.content` or a panel change size (a wrap reflow changes
  // `.content`'s height; a panel that grows moves its row-mates).
  //
  // Module drag (plan 18): a press on a panel header (ModulePanel's
  // `onheaderdown`, not its ×) starts `mdrag`. pointermove only stores the
  // client point; the rAF measure() derives the `.content` point from it, so
  // the panel follows the pointer by a translate and the cables re-measure
  // every frame. The target row is the row band under the pointer (below the
  // last: a new row, a dashed band shows), x = the panel's left snapped to
  // GRID, and `landing` = moveTo of the base layout (the drawn one, or in a
  // flow rack pinFromRects of the panels on screen; flow keeps rendering
  // until the drop) draws the dashed outline, plus fainter outlines where
  // the panels it pushes would go. Within 30 px of the rail's edge (or past
  // it) the rail auto-scrolls (edgeScroll). Release after > 3 px with a
  // changed placement: ONE setRackLayout('Move module') inside the pointer
  // gesture (one undo entry, pins included). A move that would take a panel
  // it moves out of the saved bounds is refused: red outline with the reason,
  // then the status line (flashHint) and the live region. Esc / Cmd+Z / redo
  // mid-drag cancel (registerDragCancel). Alt+arrows on a focused header
  // nudge (coalesced, history/sweep.ts) and announce where the module went;
  // Tidy drops every pos.
  //
  // Cables: the SVG has `pointer-events: none` everywhere, so it never steals
  // clicks from knobs. Cables are grabbed by their INPUT jack instead (VCV
  // style): pressing a connected input lifts that cable's plug and carries
  // it; pressing an output starts a new cable; pressing an empty input starts
  // a cable to be dropped on an output. During a drag nothing is sent; on
  // drop the target is found with document.elementFromPoint(...) and
  // closest('[data-jack]'), and exactly one engine edit (or one disconnect +
  // connect pair) is sent. Drops on anything that is not a matching jack
  // unplug a carried cable / cancel a new one.
  //
  // Keyboard patching (minimal, same Drag state with `kbd`): Enter/Space on a
  // focused jack picks it up exactly like a press would (a connected input
  // lifts its cable); Tab to another jack moves the dashed cable's free end
  // there; Enter/Space on it drops (the same drop()); Delete/Backspace
  // unplugs a carried cable; Esc or a pointer press, anywhere, cancels; a
  // re-measure (scroll, resize) keeps the free end on the focused jack. A
  // visually hidden live region says what is picked up.
  import { onDestroy, tick, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import { CATALOG, moduleDef, paramIndex } from '../../audio/catalog';
  import type { ModuleDef } from '../../audio/catalog';
  import type { AudioEngine } from '../../audio/engine';
  import { lastLive } from '../../input/lastNote.svelte';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { baseName } from '../../audio/samples';
  import { droppedFiles } from '../../library/drag';
  import { LibraryLostError, library } from '../../library/library.svelte';
  import { LIB, patchOptionValue } from '../../library/patchSource';
  import { PATCHES_DIR, patchFileName } from '../../library/scan';
  import { warningsText } from '../../project/session';
  import { banners, flashHint } from '../../state/banners.svelte';
  import { edit, markEdited } from '../../state/edits';
  import { addExamplePattern } from '../../state/example-actions';
  import { exampleFor } from '../../state/houseExamples';
  import { MAX_PATTERNS } from '../../audio/protocol';
  import { PATTERNS_FULL_TEXT } from '../../state/pattern-actions';
  import { BUILTIN_GROUPS, BUILTIN_PATCHES, isBuiltinName, trackPatch } from '../../state/patches';
  import { synthTrack } from '../../state/project.svelte';
  import type { Project, SynthTrack } from '../../state/project.svelte';
  import {
    addModule, connect, disconnect, fxPoolFullText, fxSlotsFree, loadPatch, removeModule, setParam, setParams, setRackLayout,
  } from '../../state/rack-actions';
  import { deferSampleAssign } from '../../state/sampleLoads';
  import { importSample } from '../../state/sampleImport';
  import { catalogCategoryColor, jackColor, moduleColor, SIGNAL_COLORS } from '../theme';
  import { releaseSelect, selectKey } from '../selectKey';
  import { cableBottom, cablePath } from './cables';
  import type { Pt } from './cables';
  import ModulePanel from './ModulePanel.svelte';
  import VoiceLeds from './VoiceLeds.svelte';
  import { GRID, MAX_ROW, MAX_X, inBounds, layoutRack, moveTo, pinFromRects, toPositions } from './rackLayout';
  import type { Placed } from './rackLayout';

  let { p, engine, track, onpianoroll }: {
    p: Project;
    engine: AudioEngine;
    track: SynthTrack;
    /** Show the Piano roll tab (BottomPanel); after "Add example roll". */
    onpianoroll?: () => void;
  } = $props();

  // ---- example roll (plan 13) ------------------------------------------------
  /** The house example for this patch (state/houseExamples.ts); null for starter / library patches. */
  const example = $derived(exampleFor(track.patchName));
  const patternsFull = $derived(track.patterns.length >= MAX_PATTERNS);
  /** Adds the example as a new pattern of this track (one undo step) and shows it in the Piano roll. */
  function addExample() {
    if (!example) return;
    if (!addExamplePattern(p, engine, track.id, example)) return flashHint(PATTERNS_FULL_TEXT);
    onpianoroll?.();
  }

  type End = { m: number; port: number };
  const key = (m: number, dir: 'in' | 'out', port: number) => `${m}:${dir}:${port}`;

  // ---- modules -------------------------------------------------------------
  const modules = $derived([...track.modules].sort((a, b) => a.idx - b.idx));
  /** "Oscillator 1", "Oscillator 2" when a kind appears more than once. */
  const titles = $derived.by(() => {
    const total = new Map<number, number>();
    for (const m of modules) total.set(m.kind, (total.get(m.kind) ?? 0) + 1);
    const seen = new Map<number, number>();
    const out = new Map<number, string>();
    for (const m of modules) {
      const n = (seen.get(m.kind) ?? 0) + 1;
      seen.set(m.kind, n);
      const name = moduleDef(m.kind).name;
      out.set(m.idx, total.get(m.kind)! > 1 ? `${name} ${n}` : name);
    }
    return out;
  });
  const full = $derived(track.modules.length >= CATALOG.maxModules);
  const isEdited = $derived(edited.has(track.id));

  /** A jack's colour (its signal: ui/theme.ts jackColor); a cable takes its output's. */
  function colorOf(m: number, dir: 'in' | 'out', port: number): string {
    const mod = track.modules.find((x) => x.idx === m);
    const pd = mod ? (dir === 'in' ? moduleDef(mod.kind).inputs : moduleDef(mod.kind).outputs)[port] : undefined;
    return jackColor(pd ?? { name: '', signal: 'audio' });
  }

  function portName(m: number, dir: 'in' | 'out', port: number): string {
    const mod = track.modules.find((x) => x.idx === m);
    if (!mod) return '';
    const d = moduleDef(mod.kind);
    return (dir === 'in' ? d.inputs : d.outputs)[port]?.name ?? '';
  }

  // ---- jack positions --------------------------------------------------------
  let rail = $state<HTMLElement | null>(null);
  let content = $state<HTMLElement | null>(null);
  let pos = $state<Record<string, Pt>>({});
  let size = $state({ w: 0, h: 0 });
  let measureRaf = 0;

  function measure() {
    measureRaf = 0;
    if (!content) return;
    measurePanels();
    const r0 = content.getBoundingClientRect();
    const next: Record<string, Pt> = {};
    for (const el of content.querySelectorAll<HTMLElement>('[data-jack]')) {
      const r = (el.querySelector('.hole') ?? el).getBoundingClientRect();
      next[key(Number(el.dataset.m), el.dataset.dir as 'in' | 'out', Number(el.dataset.port))] = {
        x: r.left - r0.left + r.width / 2,
        y: r.top - r0.top + r.height / 2,
      };
    }
    pos = next;
    // client* = the panels' box only. Not scroll*: that would include the
    // cable SVG itself (sized from this) and grow on every measure.
    size = { w: content.clientWidth, h: content.clientHeight };
    // Mid-drag scroll/resize: the carried end stays under the pointer, or on
    // the focused jack for a keyboard pick (it has no pointer position).
    // A module drag's `at` is only ever derived here (and on release), from
    // the client point its pointermove stored: no layout read per move.
    if (drag?.kbd) drag.at = (drag.kbdAt && next[drag.kbdAt]) || drag.at;
    else if (drag) drag.at = { x: drag.client.x - r0.left, y: drag.client.y - r0.top };
    if (mdrag) mdrag.at = { x: mdrag.client.x - r0.left, y: mdrag.client.y - r0.top };
  }
  /** Coalesced to one measure per frame (scroll and resize fire often). */
  function remeasure() {
    if (!measureRaf) measureRaf = requestAnimationFrame(measure);
  }

  // Patch change: modules or cables changed -> wait for the DOM, then measure.
  $effect(() => {
    // loadPatch/connect/disconnect/removeModule reassign these arrays and
    // addModule pushes, so identity + length covers every structural edit
    // (param changes don't move jacks and are deliberately not tracked).
    void [track.modules, track.modules.length, track.cables, track.cables.length];
    void tick().then(() => {
      observeAll();
      measure();
    });
  });
  // Observes the rail, the content and every module panel: with a 100 %-wide
  // content a panel that changes width (but not the row count) moves its
  // row-mates without resizing `.content`, so the panels need their own entry.
  let ro: ResizeObserver | null = null;
  function observeAll() {
    if (!ro || !rail || !content) return;
    ro.disconnect(); // drop panels that were removed
    ro.observe(rail);
    ro.observe(content);
    for (const el of content.children) if (el instanceof HTMLElement && el.dataset.testid?.startsWith('module-')) ro.observe(el);
  }
  $effect(() => {
    if (!rail || !content) return;
    ro = new ResizeObserver(remeasure);
    observeAll();
    rail.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    const r = rail;
    return () => {
      ro?.disconnect();
      ro = null;
      r.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      if (measureRaf) cancelAnimationFrame(measureRaf);
      measureRaf = 0;
    };
  });

  // ---- layout (plan 18: free placement) ---------------------------------------
  /** `.content`'s padding and the gap between rows (px): the CSS below. */
  const PAD = 6;
  const ROW_GAP = 14;

  /** The module panels among `.content`'s children (not the drop outline / new-row band). */
  function panels(): [idx: number, el: HTMLElement][] {
    if (!content) return [];
    const out: [number, HTMLElement][] = [];
    for (const el of content.children) {
      const m = el instanceof HTMLElement ? /^module-(\d+)$/.exec(el.dataset.testid ?? '') : null;
      if (m) out.push([Number(m[1]), el as HTMLElement]);
    }
    return out;
  }

  /** Measured panel sizes (offsetWidth/Height px; a transform does not change them), by idx. */
  let dims = $state(new Map<number, { w: number; h: number }>());
  /**
   * Re-read every panel's size; when one changed, the layout below changes,
   * so measure again once the DOM has it (jacks moved). Converges: positions
   * never change a panel's size (`width: max-content` when positioned), and
   * `h` is the NATURAL height: the panel's height minus its stretch spacer
   * (ModulePanel's `[data-stretch]`, the only flex-grow child), which is
   * what a row's min-height (positioned) or the flex stretch (flow) adds.
   * So a row height set from `h` never feeds back into `h`.
   */
  function measurePanels() {
    const next = new Map<number, { w: number; h: number }>();
    for (const [idx, el] of panels()) {
      const stretch = el.querySelector<HTMLElement>(':scope > [data-stretch]')?.offsetHeight ?? 0;
      next.set(idx, { w: el.offsetWidth, h: el.offsetHeight - stretch });
    }
    const same = next.size === dims.size && [...next].every(([i, d]) => dims.get(i)?.w === d.w && dims.get(i)?.h === d.h);
    if (same) return;
    dims = next;
    void tick().then(remeasure);
  }
  const widths = $derived(new Map([...dims].map(([i, d]) => [i, d.w])));
  /** The positioned layout (rackLayout.ts), or null: no module has a `pos`, today's flex-wrap flow. */
  const placed = $derived(layoutRack(modules, widths));
  /**
   * Positioned: each panel's left/top in `.content` px, its row's height (the
   * panel's min-height, so a row's jacks line up as in flow), and
   * `.content`'s size. Rows are as tall as their tallest panel.
   */
  const geometry = $derived.by(() => {
    if (!placed) return null;
    const rowH: number[] = [];
    for (const q of placed) rowH[q.row] = Math.max(rowH[q.row] ?? 0, dims.get(q.idx)?.h ?? 0);
    const tops: number[] = [];
    let y = PAD;
    for (let r = 0; r < rowH.length; r++) {
      tops[r] = y;
      y += (rowH[r] ?? 0) + ROW_GAP;
    }
    const at = new Map(placed.map((q) => [q.idx, { left: PAD + q.x * GRID, top: tops[q.row], height: rowH[q.row] ?? 0 }]));
    const right = Math.max(0, ...placed.map((q) => q.x * GRID + (dims.get(q.idx)?.w ?? q.w * GRID)));
    return { at, w: right + 2 * PAD, h: y - ROW_GAP + PAD };
  });
  // A move changes no module's identity and maybe no size: re-measure the jacks once it is drawn.
  $effect(() => {
    void geometry;
    void tick().then(remeasure);
  });

  /** A viewport point relative to `.content` (px). */
  function toContent(c: Pt): Pt {
    const r = content!.getBoundingClientRect();
    return { x: c.x - r.left, y: c.y - r.top };
  }
  /** Panel rects relative to `.content` (px). */
  function panelRects() {
    const r0 = content!.getBoundingClientRect();
    return panels().map(([idx, el]) => {
      const r = el.getBoundingClientRect();
      return { idx, left: r.left - r0.left, top: r.top - r0.top, width: r.width, height: r.height };
    });
  }
  /** The layout a move applies to: the drawn one, or in a flow rack the pins of what is on screen (first drag pins). */
  function moveBase(): Placed[] {
    return placed ?? pinFromRects(panelRects(), PAD);
  }
  const samePlacement = (a: readonly Placed[], b: readonly Placed[]) =>
    a.length === b.length && a.every((q) => b.some((o) => o.idx === q.idx && o.row === q.row && o.x === q.x));

  type ModDrag = {
    idx: number;
    /** The layout the drop applies to (moveBase() at the press). */
    base: Placed[];
    /** Each base row's band (`.content` px; the row's panels as they are drawn at the press). */
    bands: { top: number; bottom: number }[];
    /** Pointer at the press, now (viewport, to re-derive `at` after a scroll) and in `.content` px. */
    start: Pt;
    client: Pt;
    at0: Pt;
    at: Pt;
    /** Pointer minus the panel's left/top at the press (px). */
    grab: Pt;
    /** The dragged panel's size (px). */
    w: number;
    h: number;
    /** Every panel's size at the press (px): the outlines of the panels a drop would push. */
    sizes: Map<number, { w: number; h: number }>;
  };
  let mdrag = $state<ModDrag | null>(null);
  /** Past the 3 px click slop: the outline shows and a release moves. */
  const travelled = $derived(!!mdrag && Math.hypot(mdrag.client.x - mdrag.start.x, mdrag.client.y - mdrag.start.y) > 3);
  /**
   * Where the module would land: the row band under the pointer (below the
   * last one: a new row), x = the panel's left on the grid; moveTo pushes the
   * overlapped panels right. `top` is the band's (or the new row's) top.
   * x is clamped to MAX_X; `ok` is false when the result moves a panel out
   * of the saved bounds (a push past x 1000, a 33rd row; inBounds with the
   * base, so a panel already drawn past 1000 that this drop leaves alone
   * blocks nothing): the outline turns red with `refusal` in it and the
   * release writes nothing (patches.ts would drop the whole layout on load).
   * `pushed`: the panels the drop would push right, outlined fainter at
   * their resulting x (no surprise jumps on release).
   */
  const landing = $derived.by(() => {
    const d = mdrag;
    if (!d || !travelled) return null;
    const last = d.bands[d.bands.length - 1];
    const newTop = (last?.bottom ?? PAD - ROW_GAP) + ROW_GAP;
    const found = d.bands.findIndex((b) => d.at.y < b.bottom + ROW_GAP / 2);
    const row = found < 0 ? d.bands.length : found;
    const top = row < d.bands.length ? d.bands[row].top : newTop;
    const x = Math.min(MAX_X, Math.max(0, Math.round((d.at.x - d.grab.x - PAD) / GRID)));
    const result = moveTo(d.base, d.idx, row, x);
    const me = result.find((q) => q.idx === d.idx)!;
    // A panel other than the mover changes x only by a push (rows only renumber).
    const baseX = new Map(d.base.map((q) => [q.idx, q.x]));
    const pushed = result
      .filter((q) => q.idx !== d.idx && q.x !== baseX.get(q.idx))
      .map((q) => ({ idx: q.idx, left: PAD + q.x * GRID, top, w: d.sizes.get(q.idx)?.w ?? q.w * GRID, h: d.sizes.get(q.idx)?.h ?? d.h }));
    const ok = inBounds(result, d.base);
    return { result, ok, refusal: ok ? '' : refusalText(result), pushed, newTop, left: PAD + me.x * GRID, top };
  });
  /** Why a move out of the saved bounds is not made (drop outline, status line, live region). */
  const refusalText = (result: readonly Placed[]) =>
    result.some((q) => q.row > MAX_ROW) ? 'No more rows — move it up or Tidy' : 'Too far right — move left or Tidy';
  /** The rack's live-region news besides a pick (`jack-status`): where an Alt+arrow move went, why a move was refused. */
  let rackStatus = $state('');
  /** A refused move: the status line says why (flashHint), and so does the live region. */
  function refuse(text: string) {
    flashHint(text);
    rackStatus = text;
  }

  // Edge auto-scroll: while a module drag's pointer is within EDGE px of the
  // rail's edge (or past it), the rail scrolls toward that edge each frame,
  // faster the deeper in (EDGE_STEP px/frame at the edge and beyond). The
  // scroll event's measure() re-derives the drag point, so the panel and the
  // landing follow. Kicked by pointermove; stops when the pointer leaves the
  // zone, the rail can't scroll further, or the drag ends (cleanup cancels it).
  const EDGE = 30;
  const EDGE_STEP = 16;
  let edgeRaf = 0;
  function edgeScroll() {
    edgeRaf = 0;
    const d = mdrag;
    if (!d || !rail || !travelled) return;
    const r = rail.getBoundingClientRect();
    const speed = (depth: number) => Math.ceil(EDGE_STEP * Math.min(1, depth / EDGE));
    const step = (lo: number, hi: number, v: number) => (v < lo + EDGE ? -speed(lo + EDGE - v) : v > hi - EDGE ? speed(v - hi + EDGE) : 0);
    const dx = step(r.left, r.right, d.client.x);
    const dy = step(r.top, r.bottom, d.client.y);
    if (!dx && !dy) return;
    const { scrollLeft, scrollTop } = rail;
    rail.scrollBy(dx, dy);
    if (rail.scrollLeft !== scrollLeft || rail.scrollTop !== scrollTop) edgeRaf = requestAnimationFrame(edgeScroll);
  }

  function headerDown(e: PointerEvent, idx: number) {
    if (drag?.kbd) drag = null; // a press cancels a keyboard pick
    if (e.button !== 0 || !content || drag || mdrag) return;
    const rects = panelRects();
    const me = rects.find((r) => r.idx === idx);
    if (!me) return; // before the capture below: nothing may be left holding the pointer
    e.preventDefault(); // no text selection
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true }); // Alt+arrows go on from here
    el.setPointerCapture(e.pointerId);
    const base = moveBase();
    const bands: { top: number; bottom: number }[] = [];
    for (const q of base) {
      const r = rects.find((x) => x.idx === q.idx);
      if (!r) continue;
      const b = bands[q.row];
      bands[q.row] = b ? { top: Math.min(b.top, r.top), bottom: Math.max(b.bottom, r.top + r.height) } : { top: r.top, bottom: r.top + r.height };
    }
    const at = local(e);
    const client = { x: e.clientX, y: e.clientY };
    const sizes = new Map(rects.map((r) => [r.idx, { w: r.width, h: r.height }]));
    mdrag = { idx, base, bands, start: client, client, at0: at, at, grab: { x: at.x - me.left, y: at.y - me.top }, w: me.width, h: me.height, sizes };
    rackStatus = '';

    // Only the client point here: measure() (one rAF) derives `at` from it.
    const move = (ev: PointerEvent) => {
      if (!mdrag) return;
      mdrag.client = { x: ev.clientX, y: ev.clientY };
      remeasure(); // the panel, landing and cables follow (a frame at most behind)
      if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScroll);
    };
    const cleanup = () => {
      if (edgeRaf) cancelAnimationFrame(edgeRaf);
      edgeRaf = 0;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', esc, true);
      offUndo();
      endPointerDrag = null;
      const l = landing;
      mdrag = null;
      remeasure();
      return l;
    };
    // The one write of the drag (inside its pointer gesture: one undo entry,
    // "Move module"; in a flow rack it pins every module too). A click, a
    // drop on the module's own spot, or one out of bounds writes nothing.
    const up = (ev: PointerEvent) => {
      // The landing at the release point itself (the last move's frame may not have run).
      if (mdrag && content) {
        mdrag.client = { x: ev.clientX, y: ev.clientY };
        mdrag.at = toContent(mdrag.client);
      }
      const l = cleanup();
      if (l && !l.ok) return refuse(l.refusal);
      if (l && !samePlacement(l.result, base) && setRackLayout(p, track.id, toPositions(l.result), 'Move module')) edited.add(track.id);
    };
    const cancel = () => void cleanup();
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    // Cmd/Ctrl+Z or redo mid-drag: the same as Escape (nothing was written yet).
    const mine = mdrag;
    const offUndo = registerDragCancel(() => {
      if (mdrag !== mine) {
        offUndo();
        return false;
      }
      cleanup();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      return true;
    });
    endPointerDrag = cancel;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', esc, true);
  }

  // Keyboard: Alt+arrows on a focused header move the module one grid unit /
  // one row (same push rules). Quick nudges are one undo entry: coalesce key
  // sweepKey(`rackmove:<trackId>`), which steps after 1 s idle. The live
  // region says where it went ("Moved VCA to row 2, position 31": row
  // 1-based, position in grid units); a refused move says why (refuse()).
  const NUDGE: Record<string, [dRow: number, dx: number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
  function headerKey(e: KeyboardEvent, idx: number) {
    const d = NUDGE[e.key];
    // Only the header itself: Alt+arrows on its × button are not a move.
    if (!d || e.target !== e.currentTarget || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); // Alt+Left is the browser's Back on Windows / Linux
    e.stopPropagation();
    if (mdrag || !content) return;
    const base = moveBase();
    const me = base.find((q) => q.idx === idx);
    if (!me || me.row + d[0] < 0) return;
    const result = moveTo(base, idx, me.row + d[0], Math.min(MAX_X, Math.max(0, me.x + d[1])));
    if (samePlacement(result, base)) return; // e.g. Alt+Left into a touching neighbour (moveTo snaps back)
    if (!inBounds(result, base)) return refuse(refusalText(result));
    if (!setRackLayout(p, track.id, toPositions(result), 'Move module', sweepKey(`rackmove:${track.id}`))) return;
    edited.add(track.id);
    const at = result.find((q) => q.idx === idx)!;
    rackStatus = `Moved ${titles.get(idx) ?? 'module'} to row ${at.row + 1}, position ${at.x}`;
    const el = e.currentTarget as HTMLElement;
    void tick().then(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  /** Back to the wrapping flow: every `pos` removed (one undo entry). */
  function tidy() {
    if (setRackLayout(p, track.id, null, 'Tidy rack')) edited.add(track.id);
  }

  // ---- cables ----------------------------------------------------------------
  type Drag = {
    /** The end that stays put: an output, or (new cable from an empty input) an input. */
    fixed: End & { dir: 'in' | 'out' };
    /** Input whose existing cable is being carried (unplugged visually, not yet in the engine). */
    carry: End | null;
    /** The cable's colour (its output's signal). */
    color: string;
    /** Carried end, relative to `.content`. */
    at: Pt;
    /** Last pointer position (viewport), to re-derive `at` after a scroll. */
    client: Pt;
    /** Keyboard pick: the jack it was picked up from (`at` follows focus, not the pointer). */
    kbd?: End & { dir: 'in' | 'out' };
    /** Keyboard pick: key() of the focused jack, where the free end sits (re-read on every measure). */
    kbdAt?: string;
  };
  let drag = $state<Drag | null>(null);

  const drawn = $derived(
    track.cables
      .filter((c) => !(drag?.carry && drag.carry.m === c.to.m && drag.carry.port === c.to.port))
      .map((c) => ({
        id: key(c.to.m, 'in', c.to.port),
        a: pos[key(c.from.m, 'out', c.from.port)],
        b: pos[key(c.to.m, 'in', c.to.port)],
        color: colorOf(c.from.m, 'out', c.from.port),
      }))
      .filter((c) => c.a && c.b),
  );
  const dragA = $derived(drag ? pos[key(drag.fixed.m, drag.fixed.dir, drag.fixed.port)] : null);
  /**
   * The SVG (absolutely positioned inside the scrolled `.content`, so it
   * extends the rail's scroll area) is tall enough for the lowest point of
   * every cable: none is clipped or out of reach.
   */
  const svgH = $derived(Math.ceil(Math.max(size.h, ...drawn.map((c) => cableBottom(c.a, c.b) + 8))));

  function local(e: PointerEvent): Pt {
    const r = content!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The open pointer drag's cleanup (listeners, undo-cancel registration); run on destroy too. */
  let endPointerDrag: (() => void) | null = null;
  // The rack going away mid-drag (track switch, panel closed) must not leave
  // its window keydown listener or its registerDragCancel entry behind.
  onDestroy(() => endPointerDrag?.());

  function jackDown(e: PointerEvent, m: number, dir: 'in' | 'out', port: number) {
    if (drag?.kbd) drag = null; // a press cancels a keyboard pick
    if (e.button !== 0 || !content || drag || mdrag) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const client = { x: e.clientX, y: e.clientY };
    const existing = dir === 'in' ? track.cables.find((c) => c.to.m === m && c.to.port === port) : undefined;
    drag = existing
      ? { fixed: { ...existing.from, dir: 'out' }, carry: { m, port }, color: colorOf(existing.from.m, 'out', existing.from.port), at: local(e), client }
      : { fixed: { m, port, dir }, carry: null, color: colorOf(m, dir, port), at: local(e), client };

    const move = (ev: PointerEvent) => {
      if (!drag) return;
      drag.client = { x: ev.clientX, y: ev.clientY };
      drag.at = local(ev);
    };
    const cleanup = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', esc, true);
      offUndo();
      endPointerDrag = null;
      const d = drag;
      drag = null;
      return d;
    };
    const up = (ev: PointerEvent) => {
      const d = cleanup();
      if (d) drop(d, document.elementFromPoint(ev.clientX, ev.clientY));
    };
    // Cancel = leave everything as it was (a carried cable snaps back).
    // lostpointercapture without a pointerup (e.g. the window lost the
    // pointer) must not leave a phantom cable following nothing.
    const cancel = () => void cleanup();
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // don't also close a menu etc.
      cleanup();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    // Cmd/Ctrl+Z or redo mid-drag: the same as Escape (history/gestures.ts).
    const mine = drag;
    const offUndo = registerDragCancel(() => {
      if (drag !== mine) { // this drag already ended without its cleanup
        offUndo();
        return false;
      }
      cleanup();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      return true;
    });
    endPointerDrag = cancel;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', esc, true);
  }

  // ---- keyboard patching -------------------------------------------------------
  function jackKey(e: KeyboardEvent, m: number, dir: 'in' | 'out', port: number) {
    const k = e.key;
    if (drag?.kbd && (k === 'Delete' || k === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      const d = drag;
      drag = null;
      if (d.carry) drop(d, null); // dropped on nothing: unplug
      return;
    }
    if (k !== 'Enter' && k !== ' ') return;
    e.preventDefault();
    e.stopPropagation(); // Space must not also toggle play
    if (e.repeat) return;
    if (drag?.kbd) {
      const d = drag;
      drag = null;
      drop(d, e.currentTarget as HTMLElement); // same rules as a pointer drop
      return;
    }
    if (drag || !content) return; // a pointer drag is in progress
    const kbdAt = key(m, dir, port);
    const at = pos[kbdAt] ?? { x: 0, y: 0 };
    const existing = dir === 'in' ? track.cables.find((c) => c.to.m === m && c.to.port === port) : undefined;
    const kbd = { m, port, dir };
    rackStatus = ''; // the pick's own text takes the region (no stale move news after it)
    drag = existing
      ? { fixed: { ...existing.from, dir: 'out' }, carry: { m, port }, color: colorOf(existing.from.m, 'out', existing.from.port), at, client: { x: 0, y: 0 }, kbd, kbdAt }
      : { fixed: { m, port, dir }, carry: null, color: colorOf(m, dir, port), at, client: { x: 0, y: 0 }, kbd, kbdAt };
  }
  /** The free end of a keyboard-picked cable follows focus from jack to jack. */
  function jackFocus(m: number, dir: 'in' | 'out', port: number) {
    if (!drag?.kbd) return;
    drag.kbdAt = key(m, dir, port);
    drag.at = pos[drag.kbdAt] ?? drag.at;
  }
  // Esc anywhere, or a pointer press anywhere, cancels a keyboard pick (a
  // carried cable snaps back). A press on a jack also starts a pointer drag
  // (jackDown runs after this capture-phase listener cleared the pick).
  $effect(() => {
    if (!drag?.kbd) return;
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      drag = null;
    };
    const press = () => {
      if (drag?.kbd) drag = null;
    };
    window.addEventListener('keydown', esc, true);
    window.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('pointerdown', press, true);
    };
  });
  // Another track's rack: a pick (or a module drag) from this one is dropped.
  $effect(() => {
    void track.id;
    untrack(() => {
      if (drag?.kbd) drag = null;
      if (mdrag) endPointerDrag?.();
      rackStatus = '';
    });
  });
  const pickedText = $derived.by(() => {
    const k = drag?.kbd;
    if (!k) return '';
    const what = `${titles.get(k.m) ?? ''} ${portName(k.m, k.dir, k.port)}`;
    const then = k.dir === 'in' && drag?.carry
      ? 'Enter on another input to move the cable, Delete to unplug it, Esc to cancel'
      : `Enter on ${drag?.fixed.dir === 'out' ? 'an input' : 'an output'} to connect, Esc to cancel`;
    return `Picked up ${what}. ${then}.`;
  });

  function drop(d: Drag, under: Element | null) {
    const t = under?.closest<HTMLElement>('[data-jack]');
    const tgt = t && content?.contains(t)
      ? { m: Number(t.dataset.m), port: Number(t.dataset.port), dir: t.dataset.dir as 'in' | 'out' }
      : null;
    if (d.fixed.dir === 'out') {
      const from = { m: d.fixed.m, port: d.fixed.port };
      if (tgt?.dir === 'in') {
        if (d.carry && d.carry.m === tgt.m && d.carry.port === tgt.port) return; // put back where it was
        if (d.carry) disconnect(p, engine, track.id, d.carry);
        connect(p, engine, track.id, from, tgt); // replaces any cable already on tgt
        edited.add(track.id);
      } else if (d.carry) {
        disconnect(p, engine, track.id, d.carry); // dropped on nothing: unplug
        edited.add(track.id);
      }
    } else if (tgt?.dir === 'out') {
      connect(p, engine, track.id, tgt, { m: d.fixed.m, port: d.fixed.port });
      edited.add(track.id);
    }
  }

  // ---- edits ------------------------------------------------------------------
  function param(idx: number, i: number, v: number) {
    setParam(p, engine, track.id, idx, i, v);
    edited.add(track.id);
  }
  function params(idx: number, values: [number, number][]) {
    setParams(p, engine, track.id, idx, values);
    edited.add(track.id);
  }
  function remove(idx: number) {
    removeModule(p, engine, track.id, idx);
    edited.add(track.id);
  }
  // ---- patches: built-in + library -------------------------------------------
  // The dropdown lists the built-in patches by group (Starter, then the House
  // groups; an empty group is not shown), then the library's patches/*.json
  // (values "lib:<path>"; a library patch's name is its file name). Save
  // patch is refused under a built-in name, so a name picks one option.
  const lib = library.state;
  const libPatches = $derived(lib.source === 'folder' ? lib.patches : []);
  /** The option showing the current patch (also what revert reloads). */
  const selValue = $derived(
    patchOptionValue(track.patchName, loadedFrom.get(track.id) ?? null, BUILTIN_PATCHES.map((x) => x.name), libPatches),
  );
  /** What the last patch load dropped or clamped (validatePatch), shown inline. */
  let patchNote = $state<string | null>(null);

  /**
   * Replaces the rack with a built-in patch (by name) or a library patch
   * ("lib:<path>": read, then validated by loadPatch like any patch from
   * outside). With unsaved edits it asks first: a stray arrow key on a
   * focused select (Windows/Linux change the value without opening it) or a
   * misclick must not silently throw work away. False if declined or the
   * file could not be read (the banner says why).
   */
  async function load(value: string): Promise<boolean> {
    const tid = track.id;
    let patch: unknown;
    let name: string;
    if (value.startsWith(LIB)) {
      const path = value.slice(LIB.length);
      name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, '');
      try {
        patch = await library.readPatch(path);
      } catch (e) {
        // Lost folder: the Browser says "Reconnect folder"; no second message.
        if (!(e instanceof LibraryLostError)) patchNote = `Couldn't load "${name}" — ${e instanceof Error ? e.message : String(e)}`;
        return false;
      }
      // The file name is the patch's name (what the dropdown shows).
      if (typeof patch === 'object' && patch !== null && !Array.isArray(patch)) patch = { ...patch, name };
    } else {
      patch = BUILTIN_PATCHES.find((x) => x.name === value);
      if (!patch) return false;
      name = value;
    }
    const warnings = loadPatch(p, engine, tid, patch);
    edited.delete(tid);
    loadedFrom.set(tid, value);
    if (warnings.length) console.warn(`Patch "${name}":`, warnings);
    patchNote = warnings.length ? warningsText(`Loaded "${name}" without what was invalid`, warnings) : null;
    return true;
  }
  /** A patch load waiting on "Discard your edits?" (InlineConfirm under the control that asked). */
  let discardAsk = $state<{ value: string; anchor: HTMLElement; track: string } | null>(null);
  /** Load `value`, asking first when the rack has unsaved edits. */
  async function requestLoad(value: string, anchor: HTMLElement): Promise<boolean> {
    if (!isEdited) return load(value);
    releaseHeldKeys(); // a held piano key must not sound while the user decides
    discardAsk = { value, anchor, track: track.patchName };
    return false; // not loaded (yet): a select shows the current patch again
  }
  async function pickPatch(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    releaseSelect(sel); // give the keys back to the piano at once
    if (!(await requestLoad(sel.value, sel))) sel.value = selValue; // declined / failed: show the current patch again
  }
  const revert = (e: MouseEvent) => void requestLoad(selValue, e.currentTarget as HTMLElement);

  // ---- Save patch (to the library's patches/) ----------------------------------
  /** The inline save form; `exists`: that file is there, ask before replacing. */
  let saving = $state<{ name: string; error: string | null; exists: string | null; busy: boolean } | null>(null);
  const saveTitle = $derived(
    lib.writable
      ? "Save this rack to the library folder's patches/"
      : lib.source === 'folder' && lib.status === 'lost'
        ? 'Reconnect the library folder to save patches'
        : 'Choose a library folder to save patches',
  );
  function openSave() {
    saving = { name: isBuiltinName(track.patchName) ? '' : track.patchName, error: null, exists: null, busy: false };
    void tick().then(() => document.querySelector<HTMLInputElement>('[data-testid="patch-save-name"]')?.select());
  }
  async function save(replace = false) {
    const s = saving;
    if (!s || s.busy) return;
    const file = patchFileName(s.name);
    if (!file) return void (s.error = 'Give the patch a name');
    const name = file.slice(0, -'.json'.length);
    if (isBuiltinName(name)) return void (s.error = `"${name}" is a built-in patch — pick another name`);
    const tid = track.id;
    const t = synthTrack(p, tid);
    if (!t) return;
    s.busy = true;
    try {
      // Sample ids belong to this session: a library patch keeps no sample.
      const r = await library.savePatch(name, { ...trackPatch(t, () => -1), name }, { replace });
      if (r === 'exists') {
        s.exists = name; // as saved (patchFileName), not as typed
        s.error = null;
        return;
      }
      saving = null;
      if (t.patchName !== name) {
        edit(p, 'Rename patch', () => {
          t.patchName = name; // the rack is now that library patch (sends no command)
          markEdited(p);
        });
      }
      edited.delete(tid);
      loadedFrom.set(tid, `${LIB}${PATCHES_DIR}/${file}`);
      flashHint(`Saved patch "${name}" to the library`);
    } catch (e) {
      s.exists = null;
      s.error = e instanceof LibraryLostError
        ? 'The library folder is out of reach — reconnect it in the Browser'
        : `Couldn't save — ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      s.busy = false;
    }
  }
  function saveKey(e: KeyboardEvent) {
    if (e.key === 'Enter') void save();
    else if (e.key === 'Escape') saving = null;
  }

  // ---- Sample Player: sample picker + drop ---------------------------------------
  /** Bumped to re-read p.sampleFiles (a plain Map) when a picker opens or a drop lands. */
  let sampleTick = $state(0);
  /** The project's loaded samples by name ("kick", or "kick #3" when names repeat). */
  const sampleOptions = $derived.by(() => {
    void p.version;
    void p.loading;
    void sampleTick;
    const list = [...p.sampleFiles].map(([id, f]) => ({ id, name: baseName(f.name) })).sort((a, b) => a.id - b.id);
    const count = new Map<string, number>();
    for (const s of list) count.set(s.name, (count.get(s.name) ?? 0) + 1);
    return list.map((s) => (count.get(s.name)! > 1 ? { ...s, name: `${s.name} #${s.id}` } : s));
  });
  const SAMPLE_PARAM = paramIndex(moduleDef('sample_player'), 'sample');
  /** A Sample Player's sample's meta (its strip's peaks); sampleMeta is a plain Map, re-read on peaksVersion. */
  function sampleMetaFor(id: number) {
    void p.peaksVersion;
    return id >= 0 ? (p.sampleMeta.get(id) ?? null) : null;
  }

  /** A sample dropped on Sample Player `idx`: import it (same path as a step-grid drop), then assign it. */
  async function dropSample(e: DragEvent, idx: number) {
    let files: File[];
    try {
      files = await droppedFiles(e);
    } catch (err) {
      banners.error = err instanceof Error ? err.message : String(err);
      return;
    }
    if (!files[0]) return;
    const tid = track.id;
    const kind = moduleDef('sample_player').kind;
    const alive = () => !!synthTrack(p, tid)?.modules.some((m) => m.idx === idx && m.kind === kind);
    const r = await importSample(p, engine, files[0], alive);
    if (!r.ok) {
      if (r.error) banners.error = r.error;
      return;
    }
    const assign = (id: number) => {
      if (!alive()) return;
      setParam(p, engine, tid, idx, SAMPLE_PARAM, id);
      edited.add(tid);
      sampleTick++;
    };
    if (r.deferred) deferSampleAssign(r.id, r.name, assign);
    else {
      assign(r.id);
      banners.error = null;
    }
  }

  /** What each cable colour carries (the catalog's pitch is a cv, velocity has its own). */
  const LEGEND_TITLES: Record<string, string> = {
    audio: 'Audio signals',
    cv: 'Control voltages: pitch, envelopes, LFOs, mod',
    gate: 'Gates (note on/off)',
    vel: 'Velocity',
  };

  // ---- add-module menu ---------------------------------------------------------
  const CATEGORY_ORDER = ['source', 'shaping', 'effect', 'utility'];
  const groups = $derived.by(() => {
    const cats = [...new Set(CATALOG.modules.map((m) => m.category))];
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : 99);
    cats.sort((a, b) => rank(a) - rank(b));
    return cats.map((c) => ({ category: c, modules: CATALOG.modules.filter((m) => m.category === c) }));
  });
  let menuOpen = $state(false);
  /** Arrow keys move between the menu's items (wrapping); Home/End jump. */
  function menuKey(e: KeyboardEvent) {
    const items = [...(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
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
  let menuEl = $state<HTMLElement | null>(null);
  let menuBtn = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl?.contains(t) && !menuBtn?.contains(t)) menuOpen = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      menuOpen = false;
      menuBtn?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', esc);
    void tick().then(() => menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', esc);
    };
  });

  /**
   * Why `md` cannot be added right now: every engine FX-pool slot of its kind
   * (shared by all tracks) is in use, e.g. "All 8 delays in use"; "" if it can.
   */
  function poolFullNote(md: ModuleDef): string {
    return fxSlotsFree(p, md.id) > 0 ? '' : fxPoolFullText(md);
  }

  async function add(id: string) {
    if (poolFullNote(moduleDef(id))) return; // greyed: stays open, says why
    menuOpen = false;
    const idx = addModule(p, engine, track.id, id);
    if (idx === null) return;
    edited.add(track.id);
    await tick();
    content?.querySelector(`[data-testid="module-${idx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
</script>

<div class="rack" data-testid="rack">
  <div class="bar">
    <label class="patch">
      <span>Patch</span>
      <select data-testid="patch-select" value={selValue} onchange={pickPatch} onkeydown={selectKey}>
        {#if selValue === track.patchName && !BUILTIN_PATCHES.some((x) => x.name === track.patchName)}
          <option value={track.patchName} disabled>{track.patchName || '—'}</option>
        {/if}
        {#each BUILTIN_GROUPS.filter((g) => g.patches.length) as g (g.label)}
          <optgroup label={g.label}>
            {#each g.patches as bp (bp.name)}
              <option value={bp.name}>{bp.name}</option>
            {/each}
          </optgroup>
        {/each}
        {#if libPatches.length}
          <optgroup label="Library">
            {#each libPatches as lp (lp.path)}
              <option value={LIB + lp.path}>{lp.name}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>
    {#if isEdited}
      <span class="edited" data-testid="patch-edited" title="Changed since the patch was loaded">(edited)</span>
      <button class="link" onclick={revert} title={`Reload ${track.patchName}, discarding your changes`}>revert</button>
    {/if}
    {#if example}
      <button class="link" data-testid="rack-example" disabled={patternsFull}
        title={patternsFull ? PATTERNS_FULL_TEXT : `Add "${example.name}" as a new pattern and open it in the Piano roll`}
        onclick={addExample}>Add example roll</button>
    {/if}
    <!-- Voice activity (plan 12): the first MIDI In's voices, lit by level, ringed while the gate is held. -->
    <VoiceLeds {track} />
    <button class="btn" data-testid="rack-tidy" disabled={!placed}
      title={placed ? 'Remove every module position: back to the wrapping layout' : 'The rack already wraps (drag a module header to place it)'}
      onclick={tidy}>Tidy</button>
    <button class="btn" data-testid="patch-save" disabled={!lib.writable} title={saveTitle} onclick={openSave}>Save patch</button>
    <div class="addwrap">
      <button
        class="btn"
        bind:this={menuBtn}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >+ Add module</button>
      {#if menuOpen}
        <div class="menu" role="menu" tabindex="-1" data-testid="add-menu" bind:this={menuEl} onkeydown={menuKey}>
          {#if full}
            <p class="full">Rack is full ({CATALOG.maxModules} modules). Remove one first.</p>
          {:else}
            {#each groups as g (g.category)}
              <div class="group" style:--c={catalogCategoryColor(g.category)}>
                <div class="gh">{g.category[0].toUpperCase() + g.category.slice(1)}</div>
                {#each g.modules as md (md.id)}
                  {@const note = poolFullNote(md)}
                  <!-- The dot is the module's own header colour (a group can mix them: Shaping holds filters and envelopes). -->
                  <button role="menuitem" data-testid={`add-${md.id}`} aria-disabled={note ? 'true' : undefined}
                    title={note || undefined} onclick={() => add(md.id)}
                  ><i class="dot" style:--c={moduleColor(md)}></i>{md.name}{#if note}<small>{note}</small>{/if}</button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
    <span class="legend" aria-label="Cable colours">
      {#each Object.entries(SIGNAL_COLORS) as [sig, col] (sig)}
        <span title={LEGEND_TITLES[sig]}><i style:--c={col}></i>{sig}</span>
      {/each}
    </span>
  </div>

  {#if discardAsk}
    {@const d = discardAsk}
    <InlineConfirm
      message={`Discard your edits to "${d.track}"?`}
      anchor={d.anchor}
      confirmLabel="Discard"
      oncancel={() => (discardAsk = null)}
      onconfirm={() => {
        const value = d.value; // read before clearing: `d` follows `discardAsk`
        discardAsk = null;
        void load(value);
      }}
    />
  {/if}
  {#if saving}
    {@const sv = saving}
    <div class="note save" role="group" aria-label="Save patch">
      {#if sv.exists}
        <span data-testid="patch-replace">A patch named "{sv.exists}" is already in the library. Replace it?</span>
        <button class="ok" data-testid="patch-replace-ok" disabled={sv.busy} onclick={() => void save(true)}>Replace</button>
        <button data-testid="patch-replace-cancel" onclick={() => (sv.exists = null)}>Cancel</button>
      {:else}
        <label>Save patch as
          <input data-testid="patch-save-name" bind:value={sv.name} maxlength="64" placeholder="Patch name" onkeydown={saveKey} />
        </label>
        <button class="ok" data-testid="patch-save-ok" disabled={sv.busy} onclick={() => void save()}>Save</button>
        <button onclick={() => (saving = null)}>Cancel</button>
      {/if}
      {#if sv.error}<span class="bad" role="alert">{sv.error}</span>{/if}
    </div>
  {/if}
  {#if patchNote}
    <div class="note" data-testid="patch-warnings" role="status">
      <span>{patchNote}</span><button aria-label="Dismiss" onclick={() => (patchNote = null)}>×</button>
    </div>
  {/if}

  <!-- Keyboard patching / module move status (screen readers; the picked jack is ringed). -->
  <p class="sr-only" data-testid="jack-status" aria-live="polite">{pickedText || rackStatus}</p>
  <div class="rail" data-testid="rail" bind:this={rail}>
    <div
      class="content" bind:this={content}
      style:width={geometry ? `max(100%, ${geometry.w}px)` : undefined} style:height={geometry ? `${geometry.h}px` : undefined}
    >
      {#each modules as m (m.idx)}
        <ModulePanel
          module={m}
          def={moduleDef(m.kind)}
          owner={track.id}
          title={titles.get(m.idx) ?? ''}
          isConnected={(port) => track.cables.some((c) => c.to.m === m.idx && c.to.port === port)}
          onparam={(i, v) => param(m.idx, i, v)}
          onparams={(values) => params(m.idx, values)}
          onremove={() => remove(m.idx)}
          onjackdown={(e, dir, port) => jackDown(e, m.idx, dir, port)}
          onjackkey={(e, dir, port) => jackKey(e, m.idx, dir, port)}
          onjackfocus={(dir, port) => jackFocus(m.idx, dir, port)}
          isPicked={(dir, port) => !!drag?.kbd && drag.kbd.m === m.idx && drag.kbd.dir === dir && drag.kbd.port === port}
          tempo={p.tempo}
          samples={moduleDef(m.kind).id === 'sample_player' ? sampleOptions : null}
          onsampledrop={moduleDef(m.kind).id === 'sample_player' ? (e) => void dropSample(e, m.idx) : undefined}
          onsamplesopen={() => sampleTick++}
          sampleMeta={moduleDef(m.kind).id === 'sample_player' ? sampleMetaFor(m.params[SAMPLE_PARAM]) : null}
          sampleRate={engine.sampleRate}
          lastNote={moduleDef(m.kind).id === 'sample_player' ? lastLive.note : null}
          scope={moduleDef(m.kind).id === 'scope' ? { track: track.slot, sampleRate: engine.sampleRate } : null}
          place={geometry?.at.get(m.idx) ?? null}
          shift={mdrag?.idx === m.idx ? { x: mdrag.at.x - mdrag.at0.x, y: mdrag.at.y - mdrag.at0.y } : null}
          onheaderdown={(e) => headerDown(e, m.idx)}
          onheaderkey={(e) => headerKey(e, m.idx)}
        />
      {/each}
      {#if mdrag && landing}
        <div class="newrow" data-testid="rack-new-row" style:top={`${landing.newTop}px`} style:height={`${mdrag.h}px`}><span>new row</span></div>
        {#each landing.pushed as q (q.idx)}
          <div class="outline pushed" data-testid={`rack-push-outline-${q.idx}`}
            style:left={`${q.left}px`} style:top={`${q.top}px`} style:width={`${q.w}px`} style:height={`${q.h}px`}></div>
        {/each}
        <div class="outline" class:refused={!landing.ok} data-testid="rack-drop-outline" data-refused={!landing.ok || undefined}
          style:left={`${landing.left}px`} style:top={`${landing.top}px`} style:width={`${mdrag.w}px`} style:height={`${mdrag.h}px`}
        >{#if landing.refusal}<span data-testid="rack-drop-refusal">{landing.refusal}</span>{/if}</div>
      {/if}
      {#if modules.length === 0}
        <p class="empty">Empty rack — pick a patch or add modules. A synth needs at least MIDI In → Oscillator → Out.</p>
      {/if}
      <svg class="cables" data-testid="cables" width={size.w} height={svgH} aria-hidden="true">
        {#each drawn as c (c.id)}
          <path class="cable" d={cablePath(c.a, c.b)} stroke={c.color} />
          <circle class="plug" cx={c.a.x} cy={c.a.y} r="3.5" fill={c.color} />
          <circle class="plug" cx={c.b.x} cy={c.b.y} r="3.5" fill={c.color} />
        {/each}
        {#if drag && dragA}
          <path class="drag" d={cablePath(dragA, drag.at)} stroke={drag.color} />
          <circle class="plug" cx={drag.at.x} cy={drag.at.y} r="4.5" fill={drag.color} />
        {/if}
      </svg>
    </div>
  </div>
</div>

<style>
  /* Tokens only (spec §2): the toolbar uses the shared .btn class and the
     skinned <select>; the rail is the --work area the cards sit on. */
  .rack { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .patch { display: flex; align-items: center; gap: 6px; }
  .edited { color: var(--accent); font-size: var(--fs-lbl); }
  .link { padding: 0; border: 0; background: transparent; color: var(--text); font: 500 var(--fs-lbl) var(--font-ui); text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 2px; cursor: pointer; }
  .link:hover:not(:disabled) { color: var(--accent); }
  .link:disabled { color: var(--text-2); opacity: 0.6; cursor: not-allowed; text-decoration: none; }
  .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .addwrap { position: relative; }
  .btn { padding: 4px 10px; }
  .btn[aria-expanded='true'] { filter: brightness(1.1); }
  .menu { position: absolute; z-index: 10; top: calc(100% + 6px); left: 0; display: flex; gap: 14px; padding: 10px; border-radius: var(--r-menu); background: var(--panel); box-shadow: var(--lift); }
  .group { display: flex; flex-direction: column; gap: 1px; min-width: 104px; }
  .gh { margin-bottom: 4px; padding: 3px 8px; border-radius: var(--r-sm); background: var(--c) var(--gloss); box-shadow: var(--raised-shadow); color: var(--on-color); font: 700 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; }
  .group button { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); text-align: left; white-space: nowrap; cursor: pointer; }
  .group button:hover, .group button:focus-visible { background: var(--raised); outline: none; }
  .group button[aria-disabled='true'] { color: var(--text-2); opacity: 0.6; cursor: not-allowed; }
  .group button small { flex-basis: 100%; padding-left: 14px; font-size: var(--fs-xs); color: var(--text-2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .full { margin: 0; color: var(--accent); white-space: nowrap; }
  .legend { margin-left: auto; display: flex; gap: 10px; font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .legend span { display: flex; align-items: center; gap: 4px; }
  .legend i { width: 14px; height: 4px; border-radius: 2px; background: var(--c); }

  .note { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; border-radius: var(--r-md); background: var(--well); box-shadow: var(--well-shadow), inset 3px 0 0 var(--accent); color: var(--text); }
  .note > span { flex: 1; min-width: 0; }
  .note button { padding: 2px 10px; border: 0; border-radius: var(--r-sm); background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); cursor: pointer; }
  .note button[aria-label='Dismiss'] { padding: 0 6px; background: transparent; box-shadow: none; }
  .note .ok { background-color: var(--accent); color: var(--on-color); font-weight: 700; }
  .note button:disabled { opacity: 0.45; cursor: default; }
  .note.save { box-shadow: var(--well-shadow); }
  .note label { display: flex; align-items: center; gap: 6px; }
  .note input { width: 160px; }
  .note .bad { flex-basis: 100%; color: var(--rec); }
  .rail { flex: 1; min-height: 0; min-width: 0; overflow: auto; border-radius: var(--r-md); background: var(--work); box-shadow: var(--well-shadow); }
  /* Wraps into rows; `width: 100%` (not max-content) so the rail's width is the wrap point. */
  .content { position: relative; display: flex; flex-wrap: wrap; align-items: stretch; align-content: flex-start; gap: 14px 8px; width: 100%; box-sizing: border-box; padding: 6px; }
  .empty { margin: 8px; color: var(--text-2); }
  /* Drag feedback (plan 18): where the panel lands, and the band for a new row below the last one. */
  .outline, .newrow { position: absolute; box-sizing: border-box; pointer-events: none; border-radius: var(--r-lg); }
  .outline { border: 2px dashed var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .outline.refused { border-color: var(--rec); background: color-mix(in srgb, var(--rec) 8%, transparent); }
  /* Just under the red outline, above the lifted panel (which mostly covers the outline itself). */
  .outline.refused span { position: absolute; z-index: 5; top: 100%; left: 0; margin-top: 4px; padding: 3px 8px; border-radius: var(--r-sm); background: var(--rec); color: var(--on-color); font: 600 var(--fs-lbl) var(--font-ui); white-space: nowrap; }
  /* A panel the drop would push: where it would end up. */
  .outline.pushed { border: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent); background: none; }
  .newrow { left: 6px; right: 6px; padding: 4px 8px; border: 1px dashed var(--line); color: var(--text-2); font-size: var(--fs-lbl); }
  /* Above every panel, the lifted one (z-index 3) included: cables over modules, as in VCV. */
  .cables { position: absolute; z-index: 4; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cable, .drag { fill: none; stroke-width: 3.5; stroke-linecap: round; opacity: 0.9; }
  .drag { opacity: 1; stroke-dasharray: 6 4; }
  .plug { opacity: 0.95; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
</style>
