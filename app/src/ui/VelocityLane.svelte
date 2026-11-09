<script lang="ts">
  // The velocity lane (plan 23 Task 2; docs/architecture/sequencer.md
  // "Velocity lane"): one drum row's steps as bars under the step grid, FL's
  // graph-editor idea. StepGrid picks the row (the one whose name or a cell
  // was last clicked or focused) and mounts this under the rows.
  //
  // Columns: the same flex recipe as StepGrid's cells (groups of 4, 12 px
  // apart, 3 px between steps, flex 1 1 0 with a 7 px floor, groups at most
  // 156 px), and a label column as wide as the row's controls, so every bar
  // sits exactly under its cell at 16, 32 and 64 steps and scrolls with them.
  // Keep the two in step (the e2e checks 1 px alignment).
  //
  // Bars: lit steps only, height vel / 127 in the row colour with --gloss;
  // an accent (>= 110) gets a cap in the ring colour above it. A dashed guide
  // marks 110 ("accent"). Off steps are empty slots and can't be drawn.
  //
  // Draw: press and drag; every lit step the pointer passes over takes the
  // velocity at the pointer's y (top 127, bottom 1; stepGrid.ts laneVel).
  // Pointer samples are joined by segments (laneStroke), so a fast stroke
  // skips no step. Shift: a straight ramp from the stroke's start to the
  // pointer (steps the stroke touched outside the ramp go back to their
  // values from before it). One undo entry per stroke (the App's pointer
  // gesture; actions.ts stepVelocityGesture); Esc, a lost capture or
  // Cmd/Ctrl+Z mid-stroke (registerDragCancel) put every touched step back
  // and leave no entry. Double-click a bar: back to 100 (the two presses of
  // a double-click draw first, so that is two entries).
  //
  // Pointer-only: the keyboard path to a step's velocity is the cell keys
  // (Shift+↑ / ↓ on a focused lit cell, StepGrid), which also re-level this
  // row's bars live.
  import { onDestroy } from 'svelte';
  import { registerDragCancel } from '../history/gestures';
  import type { AudioEngine } from '../audio/engine';
  import { setStepVelocity, stepVelocityGesture } from '../state/actions';
  import type { StepVelocityGesture } from '../state/actions';
  import { ACCENT_MIN_VEL } from '../state/acidSteps';
  import type { DrumRow, DrumTrack, Project } from '../state/project.svelte';
  import { laneBarTip, laneLabel, laneStroke, laneVel, stepCellStyle, velChip } from './stepGrid';
  import type { LaneCol } from './stepGrid';

  let { p, engine, track, row, vels, stepCount, color }: {
    p: Project;
    engine: AudioEngine;
    track: DrumTrack;
    /** The lane's row. */
    row: DrumRow;
    /** That row's step velocities in the current pattern (0 = off). */
    vels: readonly number[];
    stepCount: number;
    /** The row colour (stepGrid.ts rowColor). */
    color: string;
  } = $props();

  /** A double-click's reset value: what a click lights a step with. */
  const RESET = 100;

  let laneEl: HTMLDivElement;
  let barsEl: HTMLDivElement;

  // ---- stroke ----------------------------------------------------------
  type Pt = { x: number; y: number };
  let stroke: {
    g: StepVelocityGesture;
    rowId: string;
    cols: LaneCol[];
    top: number;
    height: number;
    start: Pt;
    last: Pt;
    /** Each touched lit step's velocity from before the stroke (the Shift ramp puts back the ones outside it). */
    orig: Map<number, number>;
    end: () => void;
  } | null = null;

  /** The column whose value chip shows ("vel 96"), placed in lane px; null = no chip. */
  let chip = $state<{ step: number; x: number; y: number } | null>(null);

  function write(s: NonNullable<typeof stroke>, step: number, y: number) {
    const cur = vels[step] ?? 0;
    if (cur === 0) return; // off: an empty slot, never drawn
    if (!s.orig.has(step)) s.orig.set(step, cur);
    s.g.set(s.rowId, step, laneVel(y, s.top, s.height));
    const c = s.cols[step];
    const l = laneEl.getBoundingClientRect();
    chip = { step, x: (c.left + c.right) / 2 - l.left, y: s.top - l.top };
  }

  /** One pointer sample: a segment from the last one, or with Shift the ramp from the stroke's start. */
  function sample(s: NonNullable<typeof stroke>, pt: Pt, ramp: boolean) {
    if (ramp) {
      const hits = laneStroke(s.cols, s.start, pt);
      const inRamp = new Set(hits.map((h) => h.step));
      for (const [step, v] of s.orig) if (!inRamp.has(step)) s.g.set(s.rowId, step, v);
      for (const h of hits) write(s, h.step, h.y);
    } else for (const h of laneStroke(s.cols, s.last, pt)) write(s, h.step, h.y);
    s.last = pt;
  }

  /** The columns' x extents now, and the bar area's top and height (every column has the same). */
  function measure(): { cols: LaneCol[]; top: number; height: number } | null {
    const els = [...barsEl.querySelectorAll<HTMLElement>('[data-col]')];
    if (els.length === 0) return null;
    const rs = els.map((el) => el.getBoundingClientRect());
    return { cols: rs.map((r) => ({ left: r.left, right: r.right })), top: rs[0].top, height: rs[0].height };
  }

  function down(e: PointerEvent) {
    if (e.button !== 0 || stroke) return;
    e.preventDefault(); // no text selection, no focus move
    const m = measure();
    if (!m) return;
    const id = e.pointerId;
    barsEl.setPointerCapture(id);
    const move = (ev: PointerEvent) => {
      if (!stroke || ev.pointerId !== id) return;
      // Every sample the browser merged into this event, so a curve is followed closely.
      const evs = ev.getCoalescedEvents?.() ?? [];
      for (const c of evs.length ? evs : [ev]) sample(stroke, { x: c.clientX, y: c.clientY }, ev.shiftKey);
    };
    const up = (ev: PointerEvent) => ev.pointerId === id && end();
    const lost = () => stroke && cancel(); // capture lost without a release
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // the App's Esc-cancels-learn must not also fire
      cancel();
    };
    const end = () => {
      stroke = null;
      chip = null;
      barsEl.removeEventListener('pointermove', move);
      barsEl.removeEventListener('pointerup', up);
      barsEl.removeEventListener('pointercancel', lost);
      barsEl.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('keydown', esc, true);
    };
    barsEl.addEventListener('pointermove', move);
    barsEl.addEventListener('pointerup', up);
    barsEl.addEventListener('pointercancel', lost);
    barsEl.addEventListener('lostpointercapture', lost);
    window.addEventListener('keydown', esc, true);
    const pt = { x: e.clientX, y: e.clientY };
    stroke = { g: stepVelocityGesture(p, engine, track.id), rowId: row.id, ...m, start: pt, last: pt, orig: new Map(), end };
    sample(stroke, pt, false);
  }

  /** Esc / lost capture / Cmd+Z mid-stroke: every touched step back, no entry. */
  function cancel(): boolean {
    if (!stroke) return false;
    stroke.g.cancel();
    stroke.end();
    return true;
  }
  onDestroy(registerDragCancel(cancel));
  onDestroy(() => stroke?.end());

  /**
   * Double-click a lit bar: back to 100. The column comes from the pointer's
   * x, not the event target: the presses captured the pointer, so the
   * dblclick's target is the bar area itself.
   */
  function dbl(e: MouseEvent) {
    const m = measure();
    const pt = { x: e.clientX, y: e.clientY };
    const step = m ? laneStroke(m.cols, pt, pt)[0]?.step ?? -1 : -1;
    if (step >= 0 && (vels[step] ?? 0) > 0) setStepVelocity(p, engine, track.id, row.id, step, RESET);
  }

  const chipVel = $derived(chip ? (vels[chip.step] ?? 0) : 0);
</script>

<div
  class="lane" bind:this={laneEl} style:--c={color} style:--accent-at={ACCENT_MIN_VEL / 127}
  data-testid="vel-lane" role="group" aria-label={laneLabel(row.name)}
>
  <div class="head">
    <span class="lbl">Velocity</span>
    <span class="who"><span class="swatch" aria-hidden="true"></span><span class="name" data-testid="vel-lane-name">{row.name}</span></span>
    <span class="acc-lbl" aria-hidden="true">accent</span>
  </div>
  <!-- Pointer-only (see the header): the keyboard path is the cell keys. -->
  <div class="bars" bind:this={barsEl} role="presentation" onpointerdown={down} ondblclick={dbl}>
    {#each { length: stepCount / 4 } as _, g (g)}
      <div class="grp">
        {#each { length: 4 } as _, k (k)}
          {@const s = g * 4 + k}
          {@const v = vels[s] ?? 0}
          {@const st = stepCellStyle(v, s, false)}
          <div
            class="col" class:on={st.on} class:alt={st.alt} data-col={s} data-testid="vel-col-{s}"
            data-tip={st.on ? laneBarTip(s, v) : undefined}
          >{#if st.on}<span class="bar" class:accent={st.accent} data-testid="vel-bar-{s}" style:height="{st.fill}%"></span>{/if}</div>
        {/each}
      </div>
    {/each}
    <span class="guide" aria-hidden="true"></span>
  </div>
  <span class="del-sp" aria-hidden="true"></span>
  {#if chip && chipVel > 0}
    <span class="vchip mono" data-testid="vel-lane-chip" style:left="{chip.x}px" style:top="{chip.y}px">{velChip(chipVel)}</span>
  {/if}
</div>

<style>
  /* Spec: plan 23 Task 2. Tokens only; the row colour comes in as --c. */
  .lane { position: relative; display: flex; align-items: stretch; gap: 8px; height: 64px; flex: none; padding: 0 4px; }

  /* As wide as a row's controls (StepGrid: tag 5, name 120, wave 18, mute 22,
     gain 104, pan 80, and the 5 gaps of 8 between them), so the bars start
     where the cells do. */
  .head {
    position: relative; flex: none; width: calc(5px + 120px + 18px + 22px + 104px + 80px + 5 * 8px);
    display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 0;
  }
  .who { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .swatch { width: 10px; height: 10px; flex: none; border-radius: var(--r-xs); background: var(--c) var(--gloss); box-shadow: 0 0 6px color-mix(in srgb, var(--c) 40%, transparent); }
  .name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: 600 var(--fs-ctl) var(--font-ui); color: var(--text); }
  /* "accent", level with the guide line (the bar area is 6 px shorter than the lane: the caps' headroom). */
  .acc-lbl {
    position: absolute; right: 0; bottom: calc((100% - 6px) * var(--accent-at)); transform: translateY(50%);
    font-size: var(--fs-xs); line-height: 1; color: var(--text-2);
  }

  /* The columns: StepGrid's .cells / .grp / .cell widths, exactly. */
  .bars {
    position: relative; display: flex; gap: 12px; flex: 1; min-width: 0; padding-top: 6px;
    user-select: none; touch-action: none; cursor: crosshair;
  }
  .grp { display: flex; gap: 3px; flex: 1 1 0; min-width: 0; max-width: 156px; }
  .col {
    flex: 1 1 0; min-width: 7px; position: relative; border-radius: var(--r-sm);
    background: var(--work); box-shadow: var(--well-shadow);
  }
  .col.alt { background: color-mix(in srgb, var(--work), var(--grid)); }
  .col.on { background: color-mix(in srgb, var(--c) 12%, var(--work)); }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; border-radius: var(--r-xs) var(--r-xs) 0 0;
    background: var(--c) var(--gloss); box-shadow: var(--raised-shadow);
  }
  /* Accent (>= 110): a cap in the ring colour just above the bar, with the cells' accent glow. */
  .bar.accent::before {
    content: ''; position: absolute; left: 0; right: 0; top: -4px; height: 2px; border-radius: 1px;
    background: var(--c); box-shadow: 0 0 8px color-mix(in srgb, var(--c) 67%, transparent);
  }
  .guide {
    position: absolute; left: 0; right: 0; bottom: calc((100% - 6px) * var(--accent-at)); pointer-events: none;
    border-top: 1px dashed color-mix(in srgb, var(--text) 28%, transparent);
  }
  /* Under the rows' delete buttons. */
  .del-sp { width: 24px; flex: none; }

  /* The value chip while drawing: StepGrid's .vchip, over the drawn bar's slot. */
  .vchip {
    position: absolute; z-index: 2; transform: translate(-50%, calc(-100% - 4px)); pointer-events: none;
    padding: 1px 6px; border-radius: var(--r-xs); white-space: nowrap;
    background: var(--raised); box-shadow: var(--drop); color: var(--text);
    font-size: var(--fs-lbl); line-height: 14px;
  }
</style>
