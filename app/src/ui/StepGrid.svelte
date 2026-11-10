<script lang="ts">
  // Step grid for one drum track: one line per row (name, mute, gain, pan,
  // step cells), plus add-row / step-count / swing controls. Rows accept
  // dropped audio files (Finder) and library samples (Browser pane). All
  // edits go through actions.ts (state + engine).
  //
  // Plan 30 (owner's step grid pass): the row waveform strip (plan 12's "≈")
  // is gone (the owner found it unnecessary); the mute LED, which was lit
  // while the row PLAYED and so read as "mute is on", is a speaker toggle
  // that lights only while the row is muted (and dims the row's cells);
  // cells have one fixed width (CELL_W in the CSS), so 16 steps no longer
  // stretch across a wide panel and 32 / 64 steps scroll sideways instead
  // of squeezing; Steps, Swing (+ its MPC presets) and Humanize moved off
  // the footer into one "pattern settings" popover whose trigger reads out
  // the step count and swing; and a Kit menu in the footer swaps the
  // track's samples for another built-in kit (state/kit-actions.ts
  // loadKitOntoTrack: steps kept, one undo entry), so changing kits no
  // longer means deleting the track.
  //
  // Look (plan 20, spec §4): each row has its own colour, the palette walked
  // from the track's slot (stepGrid.ts rowColor; UI only). A cell's fill is
  // as tall as its velocity, velocity >= 110 adds the accent ring (the Acid
  // rule), and the playing step gets a white outline and a brighter fill;
  // stepGrid.ts stepCellStyle holds those rules. Gain and pan stay native
  // range inputs (skinned by theme.css): they are not rack params, so they
  // have no MIDI-learn or automation for the Knob slider variant to keep, and
  // a native drag is already one undo entry (history/gestures.ts).
  //
  // Precise value (plan 24, ui/ValuePopover.svelte): right-click, the
  // ContextMenu key or Shift+F10 on a row's gain or pan or on Swing opens the
  // popover with a KnobDef built from the slider's range (GAIN_DEF, PAN_DEF,
  // SWING_DEF below): gain as the plain multiplier it shows ("1.25", two decimals like the
  // row's readout), pan as
  // L/C/R in the grid's own spaced form (panText "L 25"; "L25" or -1..1
  // also read), swing in percent ("60"). The value is snapped to
  // the slider's 0.01 step (1 % for swing), so the popover never sets what
  // the slider can't show. Set is the slider's own action: one undo entry,
  // labelled as a drag is. No menu items (no automation, no learn).
  //
  // Delete row (plan 21 task 7): a trash button at the end of each row,
  // faded in on row hover and while focus is inside the row, but always in
  // the tab order (opacity only, never display/visibility). One undo entry
  // (actions.ts removeDrumRow). The rows have no context menu (right-click
  // on a cell clears it), so the button is the only way in.
  //
  // Swing presets and Humanize (plan 25 Task 3; docs/architecture/sequencer.md
  // "Swing presets", "Humanize"), inside the pattern settings popover (plan
  // 30): a row of MPC preset chips under the swing slider (state/groove.ts
  // SWING_PRESETS: Straight, 54-66 %); a chip is setSwing with the preset's
  // value, so one "Swing" undo entry, and the chip shows the preset the
  // swing matches. The slider and its right-click ValuePopover are
  // unchanged. Below them the Humanize amount card (HumanizeCard) whose
  // Apply is humanizeDrum on the current pattern: one "Humanize" entry.
  //
  // Step velocity (plan 23 Task 1; docs/architecture/sequencer.md "Step
  // velocity"): on a LIT cell the wheel (±5 a notch, ±1 with Shift), a
  // Shift-drag (vertical, 1 per 2 px, up is louder) and Shift+↑ / ↓ (±5;
  // Alt+Shift ±1) re-level it, clamped to 1..127 so it stays lit. The maths
  // is in stepGrid.ts, the writes in actions.ts (setStepVelocity: wheel and
  // keys coalesce per cell; stepVelocityGesture: the drag, with its Esc /
  // Cmd+Z cancel). A "vel 96" chip floats above the cell while editing.
  import { onDestroy, onMount, tick } from 'svelte';
  import Trash from 'phosphor-svelte/lib/Trash';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import SlidersHorizontal from 'phosphor-svelte/lib/SlidersHorizontal';
  import Cylinder from 'phosphor-svelte/lib/Cylinder';
  import Play from 'phosphor-svelte/lib/Play';
  import Stop from 'phosphor-svelte/lib/Stop';
  import SpeakerSimpleHigh from 'phosphor-svelte/lib/SpeakerSimpleHigh';
  import SpeakerSimpleSlash from 'phosphor-svelte/lib/SpeakerSimpleSlash';
  import { KITS } from '../state/kits';
  import { loadKitOntoTrack } from '../state/kit-actions';
  import PopButton from './PopButton.svelte';
  import HumanizeCard from './HumanizeCard.svelte';
  import { HUMANIZE_VEL, SWING_PRESETS, activeSwingPreset } from '../state/groove';
  import Icon from './Icon.svelte';
  import { registerDragCancel } from '../history/gestures';
  import { createSweepKeys } from '../history/sweep';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { droppedFiles } from '../library/drag';
  import {
    addRow, humanizeDrum, removeDrumRow, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setStepCount, setStepVelocity,
    setSwing, stepVelocityGesture,
  } from '../state/actions';
  import type { StepVelocityGesture } from '../state/actions';
  import { mod } from '../audio/audioClock';
  import type { AudioClock } from '../audio/audioClock';
  import { MAX_ROWS, currentPattern } from '../state/project.svelte';
  import { patternPosAt } from '../state/song-actions';
  import { deferSampleLoad } from '../state/sampleLoads';
  import { importSample } from '../state/sampleImport';
  import { bindPreview, previewState, togglePreview } from '../library/sharedPreview.svelte';
  import type { DrumRow, DrumTrack, Project } from '../state/project.svelte';
  import {
    dragVel, rowColor, stepCellStyle, velChip, velKeyStep, velStatus, velTip, wheelCarry, wheelNotch, wheelPx, wheelVelStep,
  } from './stepGrid';
  import { rangeFill, rangeFillBipolar } from './rangeFill';
  import { popoverHandlers, popoverOwner, type NativeReq } from './ValuePopover.svelte';
  import type { KnobDef } from './rack/knobMath';

  let { p, engine, clock, track, onerror }: {
    p: Project;
    engine: AudioEngine;
    clock: AudioClock | null;
    track: DrumTrack;
    onerror: (msg: string | null) => void;
  } = $props();

  // Row preview: clicking a row's sample name plays that sample through the
  // app-wide preview player (library/sharedPreview — the Browser's preview
  // bar shows it, with ■ Stop). Raw sample, not the row's gain/pan/mute; it
  // never touches the pattern or the undo history.
  $effect(() => bindPreview(engine));
  // Keyed by content hash, not sample id: ids restart with every New / Open /
  // restore, and the player caches decoded audio by key.
  const rowKey = (id: number) => `row:${p.sampleFiles.get(id)?.hash ?? `${p.generation}:${id}`}`;
  async function previewRow(sampleId: number, name: string) {
    const f = p.sampleFiles.get(sampleId);
    if (!f) {
      onerror(`"${name}" is still loading — try again in a moment`);
      return;
    }
    try {
      await togglePreview(rowKey(sampleId), name, async () => new Blob([f.bytes], { type: f.type }));
    } catch {
      onerror(`Couldn't preview "${name}"`);
    }
  }

  // ---- kit menu (plan 30) ----------------------------------------------
  /**
   * The kit loading now (its item says so; one load at a time, as the
   * Browser's "Load onto track"). The load always settles (kit-actions.ts),
   * so this never sticks.
   */
  let loadingKit = $state<string | null>(null);
  async function pickKit(kitId: string, close: () => void) {
    if (loadingKit) return;
    loadingKit = kitId;
    try {
      await loadKitOntoTrack(p, engine, track.id, kitId);
    } finally {
      loadingKit = null;
      close();
    }
  }

  /** The pattern being edited (steps, step count, swing); rows stay per track. */
  const pat = $derived(currentPattern(track));
  /** The swing preset the current swing matches (1 % resolution), or null. */
  const preset = $derived(activeSwingPreset(pat.swing));

  const GHOST = 60;
  const FULL = 100;

  // ---- painting -------------------------------------------------------
  // pointerdown decides the target (on->off, off->on at 100, Alt = 60);
  // entering other cells with the button held applies the same value.
  // Keyboard: Enter on a focused cell is a click with detail 0 (a mouse
  // click has detail >= 1 and was already handled on pointerdown).
  // Right-click a step clears it (no browser context menu on the cells).
  let paintVel: number | null = null;
  // Cmd/Ctrl+Z or redo mid-paint (plan 16 ruling Q): a paint has no cancel
  // (each crossed cell already holds its value; there is no single value to
  // put back), so the key is swallowed: say "dragging" without restoring
  // anything. The paint goes on and stays one entry (history/gestures.ts).
  onDestroy(registerDragCancel(() => paintVel !== null));

  function down(e: PointerEvent, rowId: string, step: number, cur: number) {
    if (e.button === 2) {
      e.preventDefault();
      if (cur > 0) setStep(p, engine, track.id, rowId, step, 0);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    // ...which also keeps the click from focusing the cell: focus it, so Space
    // then means the pattern transport (focus is inside the bottom panel).
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    // Shift on a lit cell: a velocity drag, not a paint (Shift on an off cell paints as a plain press).
    if (e.shiftKey && cur > 0) return startVelDrag(e, rowId, step, cur);
    paintVel = cur > 0 ? 0 : e.altKey ? GHOST : FULL;
    setStep(p, engine, track.id, rowId, step, paintVel);
  }
  function enter(rowId: string, step: number) {
    if (paintVel !== null) setStep(p, engine, track.id, rowId, step, paintVel);
  }

  // ---- velocity (plan 23 Task 1) ---------------------------------------
  /** Wheel / key bursts: one undo entry per cell, a new one after 1 s idle (history/sweep.ts). */
  const sweepKey = createSweepKeys();
  const velKey = (rowId: string, step: number) => `stepvel:${track.id}:${rowId}:${step}`;

  /** The cell whose value chip shows ("vel 96", read live from the pattern), placed in grid px. */
  let chip = $state<{ rowId: string; step: number; x: number; y: number } | null>(null);
  let chipTimer = 0;
  /** null when the chip's row is gone (deleted, another track shown): no chip then. */
  const chipVel = $derived.by(() => {
    if (!chip) return null;
    const r = track.rows.findIndex((x) => x.id === chip!.rowId);
    return r < 0 ? null : pat.steps[r][chip.step];
  });
  /** Show the chip above `cell`; with `ms`, hide it after that long without another edit. */
  function showChip(cell: HTMLElement, rowId: string, step: number, ms?: number) {
    const c = cell.getBoundingClientRect();
    const g = gridEl.getBoundingClientRect();
    chip = { rowId, step, x: c.left + c.width / 2 - g.left, y: c.top - g.top };
    clearTimeout(chipTimer);
    if (ms !== undefined) chipTimer = window.setTimeout(() => (chip = null), ms);
  }
  function hideChip() {
    clearTimeout(chipTimer);
    chip = null;
  }
  onDestroy(() => clearTimeout(chipTimer));

  /** The live region's text (cleared, then set a tick later, so the same value twice is still read out). */
  let velNews = $state('');
  function announce(text: string) {
    velNews = '';
    void tick().then(() => (velNews = text));
  }

  /** One coalesced step (wheel notch / key) on a lit cell. */
  function nudgeVel(cell: HTMLElement, rowId: string, step: number, cur: number, by: number) {
    const v = setStepVelocity(p, engine, track.id, rowId, step, cur + by, { coalesce: sweepKey(velKey(rowId, step)) });
    // Coalesced writes only mark the entry stale: settle now, so a burst that
    // nets to nothing (up then down) leaves no dead entry.
    p.history?.settle();
    showChip(cell, rowId, step, 1000);
    return v;
  }

  // Wheel: only a lit cell takes it (preventDefault); over an off cell the
  // page scrolls as before, and so does a mostly horizontal swipe
  // (stepGrid.ts wheelPx). Travel accumulates per cell (trackpads), one
  // step per 40 px and at most one per event (wheelNotch); partial travel
  // is dropped after 300 ms idle (wheelCarry).
  let wheelAcc = { key: '', acc: 0, t: 0 };
  function wheel(e: WheelEvent, rowId: string, step: number, cur: number) {
    if (cur === 0 || e.ctrlKey || e.metaKey) return; // Ctrl+wheel / pinch is the browser's zoom
    const px = wheelPx(e);
    if (px === 0) return;
    e.preventDefault();
    const key = velKey(rowId, step);
    const n = wheelNotch(wheelCarry(wheelAcc, key, e.timeStamp), px);
    wheelAcc = { key, acc: n.acc, t: e.timeStamp };
    if (n.notch === 0) return;
    // No button held: a click just before has released, but its gesture
    // commits a task later. Close it now, so this notch is its own "Step
    // velocity" entry, not merged into the click's "Set step" (with the
    // button still held it is the same gesture, and stays one entry).
    if (e.buttons === 0) p.history?.commit();
    nudgeVel(e.currentTarget as HTMLElement, rowId, step, cur, n.notch * wheelVelStep(e.shiftKey));
  }

  /** Shift+↑ / ↓ (±5), Alt+Shift+↑ / ↓ (±1) on a focused lit cell; announced. */
  function cellKey(e: KeyboardEvent, rowId: string, step: number, cur: number) {
    const by = velKeyStep(e);
    if (by === null || cur === 0) return;
    e.preventDefault();
    const v = nudgeVel(e.currentTarget as HTMLElement, rowId, step, cur, by);
    if (v !== null) announce(velStatus(v));
  }

  // Shift-drag on a lit cell: relative and vertical, the pointer captured
  // (no paint, the step stays lit). One undo entry: the App's pointer
  // gesture brackets it. Esc, a lost capture or Cmd/Ctrl+Z (registerDragCancel)
  // put the value from before back, leaving no entry.
  let velDrag: { g: StepVelocityGesture; start: number; y: number; end: () => void } | null = null;
  function startVelDrag(e: PointerEvent, rowId: string, step: number, cur: number) {
    const cell = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    cell.setPointerCapture(id);
    const move = (ev: PointerEvent) => {
      if (velDrag && ev.pointerId === id) velDrag.g.set(rowId, step, dragVel(velDrag.start, velDrag.y - ev.clientY));
    };
    const up = (ev: PointerEvent) => ev.pointerId === id && end();
    const lost = () => velDrag && cancelVelDrag(); // capture lost without a release
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // the App's Esc-cancels-learn must not also fire
      cancelVelDrag();
    };
    const end = () => {
      velDrag = null;
      hideChip();
      cell.removeEventListener('pointermove', move);
      cell.removeEventListener('pointerup', up);
      cell.removeEventListener('pointercancel', lost);
      cell.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('keydown', esc, true);
    };
    cell.addEventListener('pointermove', move);
    cell.addEventListener('pointerup', up);
    cell.addEventListener('pointercancel', lost);
    cell.addEventListener('lostpointercapture', lost);
    window.addEventListener('keydown', esc, true);
    velDrag = { g: stepVelocityGesture(p, engine, track.id), start: cur, y: e.clientY, end };
    showChip(cell, rowId, step);
  }
  function cancelVelDrag(): boolean {
    if (!velDrag) return false;
    velDrag.g.cancel();
    velDrag.end();
    return true;
  }
  onDestroy(registerDragCancel(cancelVelDrag));
  onDestroy(() => velDrag?.end());

  // ---- playhead -------------------------------------------------------
  let playStep = $state(-1);
  onMount(() => {
    let raf = 0;
    const loop = () => {
      const t = engine.telemetry();
      // Heard position (latency-compensated). Negative = count-in: no column.
      const ticks = clock !== null ? clock.heardTicks() : t[TELEMETRY.ticks];
      // Pattern mode: ticks loop the current pattern. Song mode: ticks are song
      // time, so ask the clips; no clip of this pattern playing -> no column.
      let next = -1;
      if (t[TELEMETRY.playing] === 1 && ticks >= 0) {
        if (p.mode === 'song') {
          const pos = patternPosAt(track, pat.id, ticks);
          if (pos !== null) next = Math.floor(pos / 240);
        } else next = Math.floor(mod(ticks, pat.stepCount * 240) / 240);
      }
      if (next !== playStep) playStep = next;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const up = () => (paintVel = null);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  });

  // ---- sample drop ----------------------------------------------------
  // Deferred loads (dropped while playing) are tracked in state/sampleLoads.ts,
  // not here: this grid unmounts while a synth track is selected, and the
  // load must still land in its row when it settles on Stop.
  let dragOver = $state<string | null>(null); // row id, or 'add'

  /**
   * Import (state/sampleImport.ts: decode, keep the original bytes for Save,
   * load into the engine); only then resolve the target row (for "+ Add row"
   * this creates it), so a failed drop leaves state unchanged. Track id is
   * captured at drop time for both the immediate and the deferred attach.
   */
  async function loadInto(file: File, target: () => string | null, tid = track.id) {
    const r = await importSample(p, engine, file, () => p.tracks.some((t) => t.id === tid));
    if (!r.ok) {
      if (r.error) onerror(r.error);
      return;
    }
    const rowId = target();
    if (!rowId) return onerror(`Row limit reached (${MAX_ROWS})`);
    if (r.deferred) deferSampleLoad(r.id, tid, rowId, r.name);
    else {
      setRowSample(p, engine, tid, rowId, r.id, r.name);
      onerror(null);
    }
  }

  /**
   * Finder files or a library sample (library/drag.ts; same import path).
   * A library folder that became unreachable gives no files and no banner:
   * the Browser pane shows "Reconnect folder".
   */
  async function dropped(e: DragEvent): Promise<File[]> {
    try {
      return await droppedFiles(e);
    } catch (err) {
      onerror(err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** The first file fills this row; any more get new rows, like "+ Add row" (one at a time, in order). */
  async function dropOnRow(e: DragEvent, rowId: string) {
    e.preventDefault();
    dragOver = null;
    const tid = track.id; // the track dropped on, even if another is selected meanwhile
    const [first, ...rest] = await dropped(e);
    if (!first) return;
    await loadInto(first, () => rowId, tid);
    for (const file of rest) await loadInto(file, () => addRow(p, engine, tid)?.id ?? null, tid);
  }
  /** Every dropped file gets its own new row, in drop order (one at a time). */
  async function dropOnAdd(e: DragEvent) {
    e.preventDefault();
    dragOver = null;
    const tid = track.id;
    for (const file of await dropped(e)) await loadInto(file, () => addRow(p, engine, tid)?.id ?? null, tid);
  }
  const allow = (e: DragEvent) => e.preventDefault();

  /** "C", "L 30", "R 50" (percent off centre). */
  function panText(v: number) {
    const n = Math.round(Math.abs(v) * 100);
    return n === 0 ? 'C' : `${v < 0 ? 'L' : 'R'} ${n}`;
  }
  const vol = (e: Event) => (e.currentTarget as HTMLInputElement).valueAsNumber;

  // ---- precise value (header: plan 24) ---------------------------------
  // KnobDefs for the native sliders: knobMath formats and parses through them
  // (0..2 is a plain number, a unitless 0..1 a percent, name 'pan' L/C/R).
  const lin: Pick<KnobDef, 'integer' | 'unit' | 'curve' | 'choices'> = { integer: false, unit: '', curve: 'lin', choices: [] };
  const GAIN_DEF: KnobDef = { ...lin, label: 'Gain', min: 0, max: 2, default: 1 };
  const PAN_DEF: KnobDef = { ...lin, label: 'Pan', name: 'pan', min: -1, max: 1, default: 0 };
  const SWING_DEF: KnobDef = { ...lin, label: 'Swing', min: 0, max: 1, default: 0 };
  /** The sliders' 0.01 step (swing's 1 %): the card never sets what the slider can't show. */
  const snap = (v: number) => Math.round(v * 100) / 100;
  /** A card request for a slider: the live value, and its action applied to the snapped value. */
  function sliderReq(label: string, def: KnobDef, value: () => number, set: (v: number) => void, format?: (v: number) => string): NativeReq {
    return { label, def, value, format, apply: (v) => { const s = snap(v); if (s !== value()) set(s); } };
  }
  // One request per slider, for both its right-click and its keys (popoverHandlers).
  const gainReq = (row: DrumRow) => sliderReq(`${row.name} gain`, GAIN_DEF, () => row.gain, (v) => setRowGain(p, engine, track.id, row.id, v), (v) => v.toFixed(2));
  const panReq = (row: DrumRow) => sliderReq(`${row.name} pan`, PAN_DEF, () => row.pan, (v) => setRowPan(p, engine, track.id, row.id, v), panText);
  const swingReq = () => sliderReq('Swing', SWING_DEF, () => pat.swing, (v) => setSwing(p, engine, track.id, v));

  // ---- delete row -----------------------------------------------------
  let gridEl: HTMLDivElement;
  /** Delete row `r`, then keep keyboard focus nearby: the delete button now
   *  at that index (the next row), else the previous row's, else "+ Add row". */
  async function deleteRow(r: number, rowId: string) {
    if (!removeDrumRow(p, engine, track.id, rowId)) return;
    await tick();
    const next = gridEl?.querySelector<HTMLElement>(`[data-testid="row-delete-${r}"]`)
      ?? gridEl?.querySelector<HTMLElement>(`[data-testid="row-delete-${r - 1}"]`)
      ?? gridEl?.querySelector<HTMLElement>('[data-testid="add-row"]');
    next?.focus({ preventScroll: true });
  }
</script>

<div class="grid" bind:this={gridEl}>
  <div class="hdr" aria-hidden="true">
    <span class="lbl tag-h"></span><span class="lbl name-h">Sample</span>
    <span class="lbl mute-h">Mute</span><span class="lbl gain-h">Gain</span><span class="lbl pan-h">Pan</span>
    <span class="lbl">Steps</span>
  </div>
  {#each track.rows as row, r (row.id)}
    {@const gain = rangeFill(row.gain / 2)}
    {@const pan = rangeFillBipolar((row.pan + 1) / 2)}
    <div
      class="row"
      class:over={dragOver === row.id}
      class:muted={row.mute}
      style:--c={rowColor(track.slot, r)}
      data-testid="row-{r}"
      role="group"
      aria-label="Row {r + 1}"
      ondragenter={(e) => { allow(e); dragOver = row.id; }}
      ondragover={allow}
      ondragleave={() => dragOver === row.id && (dragOver = null)}
      ondrop={(e) => void dropOnRow(e, row.id)}
    >
      <span class="tag" aria-hidden="true"></span>
      {#if row.sampleId === null}
        <span class="name empty" data-testid="row-name" title={row.name}>drop sample</span>
      {:else}
        {@const sid = row.sampleId}
        {@const on = previewState.key === rowKey(sid)}
        <button
          type="button" class="name prev" class:on data-testid="row-name"
          title="{row.name} — click to preview{on ? ' (click again to stop)' : ''}"
          aria-label="Preview {row.name}" aria-pressed={on}
          onclick={() => void previewRow(sid, row.name)}
        ><span class="nm">{row.name}</span><span class="pi"><Icon icon={on ? Stop : Play} size={11} weight="fill" /></span></button>
      {/if}
      <!-- A speaker toggle: plain while the row plays, lit with a slashed
           speaker while it is muted (pressed = muted). -->
      <button
        class="mute" class:on={row.mute} aria-pressed={row.mute} data-testid="row-mute-{r}"
        title={row.mute ? `${row.name} is muted — click to unmute` : `Mute ${row.name}`} aria-label="Mute {row.name}"
        onclick={() => setRowMute(p, engine, track.id, row.id, !row.mute)}
      ><Icon icon={row.mute ? SpeakerSimpleSlash : SpeakerSimpleHigh} size={14} weight={row.mute ? 'fill' : 'regular'} /></button>
      <label class="sl gain" title="Gain {row.gain.toFixed(2)}">
        <input
          type="range" min="0" max="2" step="0.01" value={row.gain} style:--fill={gain.fill}
          aria-label="Gain {row.name}" oninput={(e) => setRowGain(p, engine, track.id, row.id, vol(e))}
          use:popoverOwner {...popoverHandlers(() => gainReq(row))}
        />
        <span class="val mono">{row.gain.toFixed(2)}</span>
      </label>
      <label class="sl pan" title="Pan {panText(row.pan)}">
        <input
          type="range" min="-1" max="1" step="0.01" value={row.pan}
          style:--fill={pan.fill} style:--fill-pos={pan.pos}
          aria-label="Pan {row.name}" oninput={(e) => setRowPan(p, engine, track.id, row.id, vol(e))}
          use:popoverOwner {...popoverHandlers(() => panReq(row))}
        />
        <span class="val mono">{panText(row.pan)}</span>
      </label>
      <div class="cells">
        {#each { length: pat.stepCount / 4 } as _, g (g)}
          <div class="grp">
            {#each { length: 4 } as _, k (k)}
              {@const s = g * 4 + k}
              {@const v = pat.steps[r][s]}
              {@const st = stepCellStyle(v, s, s === playStep)}
              <button
                class="cell"
                class:on={st.on}
                class:accent={st.accent}
                class:alt={st.alt}
                class:playhead={st.playing}
                data-testid="step-{r}-{s}"
                aria-label="Row {r + 1} step {s + 1}"
                aria-pressed={st.on}
                data-tip={st.on ? velTip(v) : undefined}
                onpointerdown={(e) => down(e, row.id, s, v)}
                onwheel={(e) => wheel(e, row.id, s, v)}
                onkeydown={(e) => cellKey(e, row.id, s, v)}
                oncontextmenu={(e) => e.preventDefault()}
                onpointerenter={() => enter(row.id, s)}
                onclick={(e) => e.detail === 0 && setStep(p, engine, track.id, row.id, s, v > 0 ? 0 : FULL)}
              >{#if st.on}<span class="fill" style:height="{st.fill}%"></span>{/if}</button>
            {/each}
          </div>
        {/each}
      </div>
      <button
        type="button" class="del" data-testid="row-delete-{r}"
        title="Delete row {row.name}" aria-label="Delete row {row.name}"
        onclick={() => void deleteRow(r, row.id)}
      ><Icon icon={Trash} /></button>
    </div>
  {/each}

  {#if chip && chipVel !== null}
    <span class="vchip mono" data-testid="step-vel-chip" style:left="{chip.x}px" style:top="{chip.y}px">{velChip(chipVel)}</span>
  {/if}
  <p class="sr-only" data-testid="step-vel-status" aria-live="polite">{velNews}</p>

  <div class="foot" style:--c={track.color}>
    <button
      class="btn add" class:over={dragOver === 'add'} data-testid="add-row"
      disabled={track.rows.length >= MAX_ROWS}
      onclick={() => addRow(p, engine, track.id)}
      ondragenter={(e) => { allow(e); dragOver = 'add'; }}
      ondragover={allow}
      ondragleave={() => dragOver === 'add' && (dragOver = null)}
      ondrop={dropOnAdd}
    >+ Add row</button>
    <!-- Kit (plan 30): swap this track's samples for a built-in kit. -->
    <PopButton id="kit-menu-pop-{track.id}" label="Drum kit" testid="kit-menu-pop" place="above">
      {#snippet trigger(a)}
        <button {...a} class="btn pop" data-testid="kit-menu" title="Load a built-in drum kit onto this track (steps are kept)">
          <Icon icon={Cylinder} /> Kit <Icon icon={CaretDown} />
        </button>
      {/snippet}
      {#snippet children(close)}
        <p class="lbl pop-h">Load a kit onto “{track.name}”</p>
        <div class="kits" role="group" aria-label="Drum kits">
          {#each KITS as k (k.id)}
            <button
              type="button" class="kit" data-testid="kit-pick-{k.id}" disabled={loadingKit !== null}
              title="{k.blurb}. Each row named Kick, Clap… gets this kit's sound; steps are kept."
              onclick={() => void pickKit(k.id, close)}
            >{k.name}{loadingKit === k.id ? ' …' : ''}</button>
          {/each}
        </div>
      {/snippet}
    </PopButton>
    <!-- Pattern settings (plan 30): steps, swing (+ MPC presets), humanize. -->
    <PopButton id="pattern-settings-pop-{track.id}" label="Pattern settings" testid="pattern-settings-pop" place="above">
      {#snippet trigger(a)}
        <button {...a} class="btn pop" data-testid="pattern-settings" title="Steps, swing and humanize for this pattern">
          <Icon icon={SlidersHorizontal} />
          <span class="mono">{pat.stepCount}</span> steps · swing <span class="mono">{Math.round(pat.swing * 100)}%</span>
          <Icon icon={CaretDown} />
        </button>
      {/snippet}
      {#snippet children(close)}
        <section class="sec">
          <p class="lbl pop-h">Steps</p>
          <div class="seg" role="group" aria-label="Step count">
            {#each [16, 32, 64] as const as n (n)}
              <button
                type="button" data-testid="step-count-{n}" aria-pressed={pat.stepCount === n}
                onclick={() => setStepCount(p, engine, track.id, n)}
              >{n}</button>
            {/each}
          </div>
        </section>
        <section class="sec">
          <p class="lbl pop-h">Swing</p>
          <label class="swl">
            <span class="sr-only">Swing</span>
            <input
              class="swing" type="range" min="0" max="100" step="1" value={Math.round(pat.swing * 100)}
              style:--fill={rangeFill(pat.swing).fill}
              data-testid="swing" oninput={(e) => setSwing(p, engine, track.id, vol(e) / 100)}
              use:popoverOwner {...popoverHandlers(swingReq)}
            />
            <span class="pct mono">{Math.round(pat.swing * 100)}%</span>
          </label>
          <div class="seg" role="group" aria-label="Swing presets (MPC)" data-testid="swing-presets">
            {#each SWING_PRESETS as s (s.mpc)}
              <button
                type="button" data-testid="swing-preset-{s.mpc}" aria-pressed={preset?.mpc === s.mpc}
                title="{s.label === 'Straight' ? 'Straight (MPC 50 %)' : `MPC ${s.label}`}: swing {Math.round(s.swing * 100)}%"
                onclick={() => setSwing(p, engine, track.id, s.swing)}
              >{s.label}</button>
            {/each}
          </div>
        </section>
        <section class="sec">
          <HumanizeCard
            hint="Moves each lit step's velocity by up to ±{HUMANIZE_VEL} at 100 %. Steps never turn on or off."
            onapply={(a) => humanizeDrum(p, engine, track.id, a)} {close}
          />
        </section>
      {/snippet}
    </PopButton>
  </div>
</div>

<style>
  /* Spec §4 "Step grid". Every colour is a theme.css token; a row's colour is
     data (ui/stepGrid.ts rowColor), passed in as --c on the row. Widths: the
     header's labels line up with the row's controls (tag 5, name 120,
     mute 24, gain 104, pan 80; 8 px gaps). The grid is as wide as its
     rows (fixed cells): wider than the panel, the panel body scrolls. */
  .grid { display: flex; flex-direction: column; gap: 4px; position: relative; width: max-content; min-width: 100%; box-sizing: border-box; }
  .hdr, .row { display: flex; align-items: center; gap: 8px; padding: 0 4px; }
  .hdr { height: 14px; }
  .tag-h { width: 5px; flex: none; }
  .name-h { width: 120px; flex: none; }
  /* "MUTE" is wider than the 24 px toggle: centred, it overhangs both gaps evenly. */
  .mute-h { width: 24px; flex: none; display: flex; justify-content: center; }
  .gain-h { width: 104px; flex: none; }
  .pan-h { width: 80px; flex: none; }
  .row { height: 34px; border-radius: var(--r-sm); outline: 1px dashed transparent; outline-offset: -1px; }
  .row.over, .add.over { outline: 1px dashed var(--c); background-color: color-mix(in srgb, var(--c) 15%, transparent); }

  /* The row-colour tag, with the gloss and a glow (theme glow recipe). */
  .tag {
    width: 5px; height: 30px; flex: none; border-radius: 3px;
    background: var(--c) var(--gloss);
    box-shadow: 0 0 10px color-mix(in srgb, var(--c) 40%, transparent);
  }

  /* The name: a raised button (click previews); a Phosphor Play / Stop icon
     sits at its right end (.pi, beside the ellipsized name). */
  .name {
    display: block; width: 120px; height: 30px; flex: none; box-sizing: border-box; padding: 0 10px;
    line-height: 30px; text-align: left; border-radius: var(--r-md);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font: 600 var(--fs-ctl) var(--font-ui); color: var(--text);
  }
  .name.prev {
    border: 0; cursor: pointer; display: flex; align-items: center; gap: 6px; padding-right: 8px;
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow);
  }
  .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .pi { display: inline-flex; flex: none; color: var(--text-2); }
  .name.prev:hover { filter: brightness(1.08); }
  .name.prev:hover .pi { color: var(--text); }
  .name.prev.on { color: var(--on-color); background-color: var(--play); }
  .name.prev.on .pi { color: var(--on-color); }
  .name.prev:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .name.empty { line-height: 28px; border: 1px dashed var(--line); color: var(--text-2); font-weight: 400; font-style: italic; }

  /* Mute: a raised speaker toggle, quiet while the row plays; muted it is
     lit (--accent, as the track headers' M) with a slashed speaker, and the
     row's cells dim, so "lit" only ever means "muted". */
  .mute {
    width: 24px; height: 24px; flex: none; padding: 0; border: 0; border-radius: var(--r-sm);
    display: grid; place-items: center; cursor: pointer;
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text-2);
  }
  .mute:hover { color: var(--text); filter: brightness(1.08); }
  .mute.on {
    background-color: var(--accent); color: var(--on-color);
    box-shadow: var(--raised-shadow), 0 0 8px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .mute:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row.muted .cells { opacity: 0.45; }

  /* Gain and pan: skinned native ranges (theme.css), filled in the row colour
     (--c inherits from the row); pan fills from the centre (--fill-pos). */
  .sl { display: flex; flex-direction: column; justify-content: center; gap: 1px; flex: none; }
  .sl.gain { width: 104px; }
  .sl.pan { width: 80px; }
  .sl input { width: 100%; }
  .val { font-size: var(--fs-xs); line-height: 1; color: var(--text-2); text-align: center; }

  /* Steps: groups of 4, 10 px apart; every cell one fixed width (plan 30:
     they no longer stretch with the panel). */
  .cells { --cell-w: 30px; display: flex; gap: 10px; flex: none; user-select: none; }
  .grp { display: flex; gap: 3px; flex: none; }
  .cell {
    flex: none; width: var(--cell-w); height: 30px; padding: 0; border: 0; position: relative; overflow: hidden;
    border-radius: var(--r-sm); cursor: pointer; touch-action: none;
    /* Off: recessed, in the area colour; odd groups a shade lighter (between --work and --grid). */
    background: var(--work); box-shadow: var(--well-shadow);
  }
  .cell.alt { background: color-mix(in srgb, var(--work), var(--grid)); }
  /* On: the row colour at 25 %, and a fill as tall as the velocity (inline
     height). The cell sits up on a small drop shadow (the board's on cell). */
  .cell.on { background: color-mix(in srgb, var(--c) 25%, transparent); box-shadow: var(--drop); }
  .fill {
    position: absolute; left: 0; right: 0; bottom: 0;
    background: var(--c) var(--gloss); box-shadow: var(--raised-shadow);
  }
  /* Accent (velocity >= 110): a 2 px ring and a strong glow (the board's <c>aa, 12 px). */
  .cell.accent { box-shadow: 0 0 0 2px var(--c), 0 0 12px color-mix(in srgb, var(--c) 67%, transparent), var(--drop); }
  /* The playing step: a white outline, and its fill brightens. A dark 1 px
     ring just inside the outline keeps it readable on pale row colours
     (yellows, the brightened fill); ::after paints over the fill. */
  .cell.playhead { outline: 2px solid color-mix(in srgb, var(--text) 75%, transparent); outline-offset: -2px; }
  .cell.playhead.on { outline-color: var(--text); }
  .cell.playhead.on::after {
    content: ''; position: absolute; inset: 2px; border-radius: calc(var(--r-sm) - 2px); pointer-events: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--on-color) 70%, transparent);
  }
  .cell.playhead .fill { filter: brightness(1.25); }
  .cell:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* Delete row: an icon button at the row's end, faint until the row is
     hovered or holds focus (opacity only: it stays focusable). */
  .del {
    width: 24px; height: 24px; flex: none; padding: 0; border: 0; border-radius: var(--r-sm);
    display: grid; place-items: center; background: transparent; color: var(--text-2); cursor: pointer;
    opacity: 0; transition: opacity 0.12s;
  }
  .row:hover .del, .row:focus-within .del { opacity: 1; }
  .del:hover { color: var(--rec); background: var(--raised); }
  .del:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: 1px; }

  /* The velocity chip: centred over the edited cell, just above it (out of
     flow, so the rows never move); JetBrains Mono, tabular figures (.mono). */
  .vchip {
    position: absolute; z-index: 2; transform: translate(-50%, calc(-100% - 4px)); pointer-events: none;
    padding: 1px 6px; border-radius: var(--r-xs); white-space: nowrap;
    background: var(--raised); box-shadow: var(--drop); color: var(--text);
    font-size: var(--fs-lbl); line-height: 14px;
  }

  /* The footer stays at the panel's left edge while the cells scroll sideways. */
  .foot { position: sticky; left: 0; align-self: flex-start; display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 0 4px; color: var(--text-2); }
  .add { padding: 4px 12px; }
  .pop { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; }
  .pop .mono { color: var(--text); }
  .pop-h { margin: 0; }
  /* The popovers' content (PopButton's card is a column with 8 px gaps). */
  .sec { display: flex; flex-direction: column; gap: 6px; }
  .sec + .sec { padding-top: 8px; border-top: 1px solid var(--line); }
  .swl { display: flex; align-items: center; gap: 8px; }
  .swing { width: 180px; }
  .pct { width: 36px; text-align: right; color: var(--text); }
  .kits { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
  .kit {
    font: 500 var(--fs-ctl) var(--font-ui); text-align: left; padding: 5px 10px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--text); cursor: pointer;
  }
  .kit:hover:not(:disabled), .kit:focus-visible { background: var(--raised); outline: none; }
  .kit:disabled { color: var(--text-2); cursor: progress; }
</style>
