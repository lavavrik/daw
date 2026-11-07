<script lang="ts">
  // One automation lane row of the song timeline (plan 10; spec addendum
  // §3.4). Timeline.svelte places it at its row of the layout map
  // (tlMath.rowLayout: AUTO_H px under its owner's clip row); its header is
  // in TrackHeaders.svelte.
  //
  // Drawing (its own canvas, so editing a lane never redraws the clips and
  // their waveforms): the curve in the owner's colour (the Master row's in
  // the master grey), filled below; before the first point and after the
  // last the lane holds that point's value. A linear segment is a straight
  // line: values are drawn at their KNOB position (an exp param, e.g. a
  // cutoff, logarithmically), which is the space the engine interpolates in.
  // A hold point keeps its value up to the next point, then steps (drawn as a
  // square dot). Selected points are white. A disabled lane is dimmed; a
  // suspended one (a manual move overrides it until its next point: Task 4's
  // knob-follow loop sets laneView.suspended) is grey. An empty lane shows
  // its target's base value as a dashed line.
  //
  // Mouse (one gesture = one undo entry: history/gestures.ts brackets every
  // press .. release):
  // - click empty space: add a point at the 1/16 under the pointer (Alt: the
  //   exact tick), at the value under it, and keep dragging it;
  // - drag a point (or the selection holding it): moves them together, within
  //   their unmoved neighbours (the order never changes) and the range;
  //   snapped to 1/16 by the dragged point (Alt: free). movePoints gets the
  //   gesture's ORIGIN and the cumulative deltas (dValue in knob position),
  //   so nothing is lost to clamping on the way;
  // - Shift-click a point toggles it; Shift-drag box-selects (adds);
  // - Cmd/Ctrl-drag draws freehand: the stroke is previewed, and on release
  //   drawPoints thins it (Ramer–Douglas–Peucker, ½ % of the travel) and
  //   replaces the points in its tick range: one edit;
  // - double-click a point deletes it; right-click a point: Linear / Hold /
  //   Delete (for the selection holding it);
  // - hovering shows the value (the param's units) under the pointer.
  // Drags apply at most once per animation frame; Escape or a lost pointer
  // capture puts the points back (a point placed by the press goes again).
  // Pointer events stop here: the timeline's clip handlers never see them.
  //
  // KEYBOARD (focus rule as for the clip lanes): Delete / Backspace delete the
  // selected points, Cmd/Ctrl+A selects all, Escape cancels a drag / closes
  // the menu / clears the selection, ← / → nudge the selection a 1/16
  // (Shift: a beat). Every other key bubbles on (the QWERTY piano, Space...).
  import { onDestroy, untrack } from 'svelte';
  import { moduleDef } from '../../audio/catalog';
  import type { MixParamDef } from '../../audio/mixerCatalog';
  import type { CommandSink } from '../../state/actions';
  import { isMasterChannel } from '../../state/automation';
  import type { AutoDef, AutoOwner } from '../../state/automation';
  import { MAX_AUTO_POINTS } from '../../audio/protocol';
  import { laneView } from './laneView.svelte';
  import { addPoint, deletePoints, drawPoints, movePoints, setPointShape } from '../../state/automation-actions';
  import type { AutomationLane, Project } from '../../state/project.svelte';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { formatValue, fromPos, toPos } from '../rack/knobMath';
  import { AUTO_H, AUTO_PAD, BEAT, lanePolyline, pointBox, pointHit, posToY, snap, tickToX, xToTick, yToPos } from './tlMath';
  import type { TlView } from './tlMath';

  let {
    p, engine, lane, owner, def, color, view, width, dpr, top, testid, label, suspended = false, root = null, onhint,
  }: {
    p: Project;
    engine: CommandSink;
    lane: AutomationLane;
    owner: AutoOwner;
    def: AutoDef;
    color: string;
    view: TlView;
    width: number;
    dpr: number;
    /** Content y of the row (tlMath.rowLayout). */
    top: number;
    testid: string;
    label: string;
    suspended?: boolean;
    /** The timeline's vertical scroll container: only lanes in (or near) its view draw. */
    root?: Element | null;
    onhint: (text: string) => void;
  } = $props();

  /** A 1/16 note: the point grid. */
  const STEP = BEAT / 4;
  const DRAG_SLOP = 3;
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const H = AUTO_H;

  let el = $state<HTMLDivElement | null>(null);
  let cv = $state<HTMLCanvasElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let selected = $state.raw<Set<string>>(new Set());
  let box = $state.raw<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The freehand stroke being drawn (lane-local px), previewed until release. */
  let stroke = $state.raw<{ x: number; y: number }[] | null>(null);
  let tip = $state.raw<{ x: number; y: number; text: string } | null>(null);
  let menu = $state.raw<{ x: number; y: number; ids: string[] } | null>(null);
  let cursor = $state('crosshair');

  /** Selected ids that still exist. */
  const sel = $derived(lane.points.filter((x) => selected.has(x.id)).map((x) => x.id));
  const geom = $derived({ points: lane.points, def });

  /** The target's base value (what plays where the lane does not apply): drawn while the lane is empty. */
  function baseValue(): number {
    const t = lane.target;
    if (t.kind === 'mix') {
      const ch = isMasterChannel(owner) ? p.mixer[owner] : p.mixer.channels[owner.id];
      return ch?.params[(def as MixParamDef).id] ?? def.default;
    }
    if (isMasterChannel(owner) || owner.kind !== 'synth') return def.default;
    const m = owner.modules.find((x) => x.idx === t.module);
    const i = m ? moduleDef(m.kind).params.findIndex((d) => d.name === t.param) : -1;
    return m && i >= 0 ? m.params[i] : def.default;
  }

  // ---- drawing -----------------------------------------------------------------
  function draw() {
    const c = cv;
    const v = view;
    const W = width;
    if (!c || W <= 0) return;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const col = suspended ? '#7d808c' : color;
    const pts = lane.points.map((x) => ({ id: x.id, x: tickToX(x.tick, v), y: posToY(toPos(def, x.value)), hold: x.hold }));
    ctx.globalAlpha = lane.enabled ? 1 : 0.4;
    if (!pts.length) {
      const y = Math.round(posToY(toPos(def, baseValue()))) + 0.5;
      ctx.strokeStyle = col;
      ctx.globalAlpha *= 0.6;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = '#8d90a0';
      ctx.textBaseline = 'top';
      ctx.fillText(`Click to add a point · ${IS_MAC ? 'Cmd' : 'Ctrl'}-drag to draw`, 6, y < H / 2 ? y + 4 : y - 14);
    } else {
      // The curve (tlMath.lanePolyline: what laneValueAt plays, flat before the first and after the last point).
      const path = new Path2D();
      lanePolyline(lane.points, def, v, W).forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      const fill = new Path2D(path);
      fill.lineTo(W + 1, H);
      fill.lineTo(-1, H);
      fill.closePath();
      const a0 = ctx.globalAlpha;
      ctx.fillStyle = col;
      ctx.globalAlpha = a0 * 0.14;
      ctx.fill(fill);
      ctx.globalAlpha = a0;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
      // The points (only those in view): hold points square, the selection white.
      for (const q of pts) {
        if (q.x < -6 || q.x > W + 6) continue;
        const on = selected.has(q.id);
        ctx.fillStyle = on ? '#ffffff' : '#17181c';
        ctx.strokeStyle = on ? '#ffffff' : col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (q.hold) ctx.rect(q.x - 3, q.y - 3, 6, 6);
        else ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (stroke && stroke.length) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      stroke.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)));
      ctx.stroke();
    }
    if (box) {
      const bx = Math.min(box.x0, box.x1);
      const by = Math.min(box.y0, box.y1);
      ctx.fillStyle = 'rgba(240,162,58,0.12)';
      ctx.strokeStyle = '#f0a23a';
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    }
  }
  // Only a lane in (or within VIEW_MARGIN of) the timeline's view draws. Every
  // lane redraws on each view change (a scroll or zoom step), and with all 64
  // lanes open that cost ~60 ms per wheel step (plan 10 Task 5, the serial
  // perf e2e); out of view a lane also gives back its canvas backing store
  // (64 retina-wide lanes would hold ~90 MB). An off-screen lane draws again,
  // at the current view, when it scrolls into the margin. A lane under a
  // gesture (or holding the pointer) is in view by definition.
  const VIEW_MARGIN = 2 * H;
  let shown = $state(false);
  $effect(() => {
    const e = el;
    if (!e || typeof IntersectionObserver === 'undefined') {
      shown = true;
      return;
    }
    const io = new IntersectionObserver((xs) => (shown = xs[xs.length - 1].isIntersecting), { root, rootMargin: `${VIEW_MARGIN}px 0px` });
    io.observe(e);
    return () => io.disconnect();
  });
  $effect(() => {
    if (!shown) {
      if (cv && cv.width) (cv.width = 0), (cv.height = 0); // free the backing store
      return;
    }
    // Every point field the drawing shows (the proxies are read in draw too, but be explicit).
    for (const x of lane.points) void (x.tick + x.value + (x.hold ? 1 : 0));
    void lane.enabled;
    draw();
  });

  // ---- pointer -------------------------------------------------------------------
  type Drag =
    | {
        kind: 'move'; ids: string[]; origin: Map<string, { tick: number; value: number }>; anchor: { id: string; tick: number };
        x0: number; y0: number; moved: boolean; last: string; placed: boolean; wasMulti: boolean;
      }
    | { kind: 'box'; base: Set<string> }
    | { kind: 'draw'; samples: { tick: number; value: number }[] };
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

  function local(e: { clientX: number; clientY: number }) {
    const r = el!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  const valueAt = (y: number) => fromPos(def, yToPos(y));
  const pointById = (id: string) => lane.points.find((x) => x.id === id);

  function startMove(id: string, x: number, y: number, placed: boolean, wasMulti: boolean) {
    const ids = sel.includes(id) ? sel : [id];
    const origin = new Map(lane.points.filter((q) => ids.includes(q.id)).map((q) => [q.id, { tick: q.tick, value: q.value }]));
    drag = { kind: 'move', ids, origin, anchor: { id, tick: origin.get(id)!.tick }, x0: x, y0: y, moved: false, last: '', placed, wasMulti };
  }

  function down(e: PointerEvent) {
    e.stopPropagation(); // never the timeline's clip handlers
    if (e.button !== 0 || !el) return;
    // macOS: Ctrl+click is a right click (the contextmenu event follows).
    if (IS_MAC && e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    menu = null;
    el.focus({ preventScroll: true });
    const v = view;
    const { x, y } = local(e);
    const drawKey = IS_MAC ? e.metaKey : e.ctrlKey || e.metaKey;
    if (drawKey) {
      drag = { kind: 'draw', samples: [{ tick: xToTick(x, v), value: valueAt(y) }] };
      stroke = [{ x, y }];
    } else {
      const hit = pointHit(geom, x, y, v);
      if (hit && e.shiftKey) {
        const s = new Set(sel);
        if (s.has(hit)) s.delete(hit);
        else s.add(hit);
        selected = s;
        return;
      }
      if (hit) {
        const wasMulti = selected.has(hit) && sel.length > 1;
        if (!selected.has(hit)) selected = new Set([hit]);
        startMove(hit, x, y, false, wasMulti);
      } else if (e.shiftKey) {
        drag = { kind: 'box', base: new Set(sel) };
        box = { x0: x, y0: y, x1: x, y1: y };
      } else {
        const raw = xToTick(x, v);
        const tick = Math.max(0, e.altKey ? Math.round(raw) : snap(raw, STEP));
        const at = lane.points.find((q) => q.tick === tick);
        if (at) { // that grid line has a point already (off its dot): grab it instead
          selected = new Set([at.id]);
          startMove(at.id, x, y, false, false);
        } else {
          const pt = addPoint(p, engine, lane.id, { tick, value: valueAt(y) });
          if (!pt) {
            onhint(`${label}: ${MAX_AUTO_POINTS} points is the most a lane holds`);
            return;
          }
          selected = new Set([pt.id]);
          startMove(pt.id, x, y, true, false);
        }
      }
    }
    laneView.gesture = true; // no play-follow page flip under the press (Timeline)
    el.setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    e.stopPropagation();
    const v = view;
    const { x, y } = local(e);
    const d = drag;
    if (!d) {
      const hit = pointHit(geom, x, y, v);
      const pt = hit ? pointById(hit) : null;
      cursor = hit ? 'grab' : 'crosshair';
      tip = { x, y, text: formatValue(def, pt ? pt.value : valueAt(y)) };
      return;
    }
    if (d.kind === 'draw') {
      d.samples.push({ tick: xToTick(x, v), value: valueAt(y) });
      stroke = [...stroke!, { x, y }];
      tip = { x, y, text: formatValue(def, valueAt(y)) };
      return;
    }
    if (d.kind === 'box') {
      box = { ...box!, x1: x, y1: y };
      const s = new Set(d.base);
      for (const id of pointBox(geom, box.x0, box.y0, x, y, v)) s.add(id);
      selected = s;
      return;
    }
    const dx = x - d.x0;
    const dy = y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    d.moved = true;
    const a = d.anchor;
    const dt = e.altKey ? Math.round(dx * v.ticksPerPx) : snap(a.tick + dx * v.ticksPerPx, STEP) - a.tick;
    const dv = -dy / (H - 2 * AUTO_PAD); // knob position: the curve's travel is the row minus its padding
    const o = d.origin.get(a.id)!;
    tip = { x, y, text: formatValue(def, fromPos(def, toPos(def, o.value) + dv)) };
    const k = `${dt},${dv}`;
    if (k === d.last) return;
    d.last = k;
    schedule(() => movePoints(p, engine, lane.id, d.ids, dt, dv, d.origin));
  }

  function up(e: PointerEvent) {
    e.stopPropagation();
    const d = drag;
    if (!d) return;
    drag = null; // first: the lostpointercapture that follows must not cancel
    laneView.gesture = false;
    flush();
    if (d.kind === 'box') box = null;
    else if (d.kind === 'draw') {
      stroke = null;
      // Refused: nothing usable drawn, or too many points. Only the second says so (it is
      // possible only when the lane's points and the stroke's samples together pass the cap).
      if (!drawPoints(p, engine, lane.id, d.samples) && lane.points.length + d.samples.length > MAX_AUTO_POINTS) {
        onhint(`${label}: the drawing would pass ${MAX_AUTO_POINTS} points`);
      }
    } else if (!d.moved && d.wasMulti && !e.shiftKey) selected = new Set([d.anchor.id]);
  }

  /** Abort the drag and put the points back. */
  function cancel() {
    const d = drag;
    if (!d) return;
    drag = null;
    laneView.gesture = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    if (d.kind === 'box') {
      selected = d.base;
      box = null;
    } else if (d.kind === 'draw') stroke = null;
    else if (d.placed) {
      deletePoints(p, engine, lane.id, d.ids);
      selected = new Set();
    } else if (d.moved) movePoints(p, engine, lane.id, d.ids, 0, 0, d.origin);
  }

  function dbl(e: MouseEvent) {
    e.stopPropagation();
    const { x, y } = local(e);
    const hit = pointHit(geom, x, y, view);
    if (hit) deletePoints(p, engine, lane.id, [hit]);
  }

  function context(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (drag) return;
    const { x, y } = local(e);
    const hit = pointHit(geom, x, y, view);
    if (!hit) {
      menu = null;
      return;
    }
    if (!selected.has(hit)) selected = new Set([hit]);
    menu = { x: e.clientX, y: e.clientY, ids: sel.includes(hit) ? sel : [hit] };
  }
  const menuHold = $derived(menu ? menu.ids.every((id) => pointById(id)?.hold) : false);
  function closeMenu() {
    menu = null;
    el?.focus({ preventScroll: true });
  }
  function shape(hold: boolean) {
    if (menu) setPointShape(p, engine, lane.id, menu.ids, hold);
    closeMenu();
  }
  function menuDelete() {
    if (menu) deletePoints(p, engine, lane.id, menu.ids);
    selected = new Set();
    closeMenu();
  }
  // Keep the menu inside the window; an outside press closes it.
  $effect(() => {
    const m = menu;
    const me = menuEl;
    if (!m || !me) return;
    const r = me.getBoundingClientRect();
    const x = Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4));
    if (x !== m.x || y !== m.y) menu = { ...m, x, y };
  });
  $effect(() => {
    if (!menu) return;
    const me = menuEl;
    untrack(() => (me?.querySelector('button') as HTMLButtonElement | null)?.focus());
    const onDown = (e: PointerEvent) => {
      if (me && !me.contains(e.target as Node)) menu = null;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });

  // ---- keyboard (see KEYBOARD at the top) ------------------------------------------
  function key(e: KeyboardEvent) {
    if (e.target !== el) return; // keys from the menu are not ours
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
        deletePoints(p, engine, lane.id, sel);
        selected = new Set();
      }
    } else if (e.code === 'KeyA' && cmd && !e.altKey) {
      take();
      releaseHeldKeys(); // the shortcuts would have, on Meta (macOS eats keyups during Cmd chords)
      selected = new Set(lane.points.map((x) => x.id));
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !cmd && !e.altKey && sel.length && !drag) {
      take();
      const step = e.shiftKey ? BEAT : STEP;
      movePoints(p, engine, lane.id, sel, e.key === 'ArrowLeft' ? -step : step, 0);
    }
  }

  onDestroy(() => {
    flush();
    if (drag) laneView.gesture = false; // removed mid-press (an undo, a removed track)
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="auto"
  bind:this={el}
  data-testid={testid}
  data-lane={lane.lane}
  data-points={lane.points.length}
  data-selected={sel.length}
  data-shown={shown ? 1 : 0}
  style:top="{top}px"
  style:height="{H}px"
  style:cursor
  tabindex="0"
  role="application"
  aria-label="Automation: {label}. {lane.points.length} points. Click to add a point, drag to move, {IS_MAC ? 'Cmd' : 'Ctrl'}-drag to draw, Delete removes, arrows nudge."
  title="{label} — click: add a point (1/16, Alt: free) · drag: move · Shift-drag: select · {IS_MAC ? 'Cmd' : 'Ctrl'}-drag: draw · double-click: delete · right-click: Linear / Hold"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  onlostpointercapture={cancel}
  onpointerleave={() => { if (!drag) tip = null; }}
  ondblclick={dbl}
  oncontextmenu={context}
  onkeydown={key}
>
  <canvas bind:this={cv} class="cv" aria-hidden="true"></canvas>
  {#if tip}
    <span class="tip" data-testid="{testid}-tip" style:left="{Math.min(tip.x + 10, width - 70)}px" style:top="{tip.y < H / 2 ? tip.y + 8 : tip.y - 20}px">{tip.text}</span>
  {/if}
</div>
{#if menu}
  <div
    class="menu"
    bind:this={menuEl}
    data-testid="auto-menu"
    role="menu"
    tabindex="-1"
    style:left="{menu.x}px"
    style:top="{menu.y}px"
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <div class="menu-ttl">{label}{menu.ids.length > 1 ? ` · ${menu.ids.length} points` : ''}</div>
    <button role="menuitemradio" aria-checked={!menuHold} data-testid="auto-menu-linear" title="A straight line to the next point" onclick={() => shape(false)}>
      <span class="check" aria-hidden="true">{menuHold ? '' : '✓'}</span>Linear
    </button>
    <button role="menuitemradio" aria-checked={menuHold} data-testid="auto-menu-hold" title="Keep this value until the next point, then step" onclick={() => shape(true)}>
      <span class="check" aria-hidden="true">{menuHold ? '✓' : ''}</span>Hold
    </button>
    <button role="menuitem" data-testid="auto-menu-delete" onclick={menuDelete}>Delete</button>
  </div>
{/if}

<style>
  .auto { position: absolute; left: 0; right: 0; outline: none; touch-action: none; }
  .auto:focus-visible { box-shadow: inset 0 0 0 1px #f0a23a88; }
  .cv { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .tip { position: absolute; pointer-events: none; padding: 1px 4px; border-radius: 3px; background: rgba(18, 19, 23, 0.85); color: #e4e5ea; font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  .menu { position: fixed; z-index: 50; min-width: 130px; padding: 4px; background: #24262c; border: 1px solid #3a3d48; border-radius: 4px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; }
  .menu-ttl { font-size: 10px; color: #8d90a0; padding: 2px 6px 4px; white-space: nowrap; }
  .menu button { font: inherit; text-align: left; padding: 4px 8px; border: 0; border-radius: 3px; background: transparent; color: #e4e5ea; cursor: pointer; }
  .menu button:hover, .menu button:focus-visible { background: #343846; outline: none; }
  .menu .check { display: inline-block; width: 14px; }
</style>
