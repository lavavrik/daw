<script lang="ts">
  // Step grid for one drum track: one line per row (name, mute, gain, pan,
  // step cells), plus add-row / step-count / swing controls. Rows accept
  // dropped audio files (Finder) and library samples (Browser pane). All
  // edits go through actions.ts (state + engine).
  import { onMount } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { droppedFiles } from '../library/drag';
  import {
    addRow, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setStepCount, setSwing,
  } from '../state/actions';
  import { mod } from '../audio/audioClock';
  import type { AudioClock } from '../audio/audioClock';
  import { MAX_ROWS, currentPattern } from '../state/project.svelte';
  import { patternPosAt } from '../state/song-actions';
  import { deferSampleLoad } from '../state/sampleLoads';
  import { importSample } from '../state/sampleImport';
  import type { DrumTrack, Project } from '../state/project.svelte';

  let { p, engine, clock, track, onerror }: {
    p: Project;
    engine: AudioEngine;
    clock: AudioClock | null;
    track: DrumTrack;
    onerror: (msg: string | null) => void;
  } = $props();

  /** The pattern being edited (steps, step count, swing); rows stay per track. */
  const pat = $derived(currentPattern(track));

  const GHOST = 60;
  const FULL = 100;

  // ---- painting -------------------------------------------------------
  // pointerdown decides the target (on->off, off->on at 100, Alt = 60);
  // entering other cells with the button held applies the same value.
  let paintVel: number | null = null;

  function down(e: PointerEvent, rowId: string, step: number, cur: number) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    paintVel = cur > 0 ? 0 : e.altKey ? GHOST : FULL;
    setStep(p, engine, track.id, rowId, step, paintVel);
  }
  function enter(rowId: string, step: number) {
    if (paintVel !== null) setStep(p, engine, track.id, rowId, step, paintVel);
  }

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
  async function loadInto(file: File, target: () => string | null) {
    const tid = track.id;
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

  function dropOnRow(e: DragEvent, rowId: string) {
    e.preventDefault();
    dragOver = null;
    void dropped(e).then((files) => {
      if (files[0]) void loadInto(files[0], () => rowId);
    });
  }
  /** Every dropped file gets its own new row, in drop order (one at a time). */
  async function dropOnAdd(e: DragEvent) {
    e.preventDefault();
    dragOver = null;
    for (const file of await dropped(e)) await loadInto(file, () => addRow(p, engine, track.id)?.id ?? null);
  }
  const allow = (e: DragEvent) => e.preventDefault();

  /** "C", "L 30", "R 50" (percent off centre). */
  function panText(v: number) {
    const n = Math.round(Math.abs(v) * 100);
    return n === 0 ? 'C' : `${v < 0 ? 'L' : 'R'} ${n}`;
  }
  const vol = (e: Event) => (e.currentTarget as HTMLInputElement).valueAsNumber;
</script>

<div class="grid" style:--c={track.color}>
  <div class="hdr" aria-hidden="true">
    <span class="name">Sample</span><span class="mute-h">Mute</span>
    <span class="knob-h">Gain</span><span class="knob-h">Pan</span><span class="cells-h">Steps</span>
  </div>
  {#each track.rows as row, r (row.id)}
    <div
      class="row"
      class:over={dragOver === row.id}
      data-testid="row-{r}"
      role="group"
      aria-label="Row {r + 1}"
      ondragenter={(e) => { allow(e); dragOver = row.id; }}
      ondragover={allow}
      ondragleave={() => dragOver === row.id && (dragOver = null)}
      ondrop={(e) => dropOnRow(e, row.id)}
    >
      <span class="name" class:empty={row.sampleId === null} data-testid="row-name" title={row.name}>
        {row.sampleId === null ? 'drop sample' : row.name}
      </span>
      <button
        class="mute" class:on={row.mute} aria-pressed={row.mute}
        title="Mute {row.name}" aria-label="Mute {row.name}"
        onclick={() => setRowMute(p, engine, track.id, row.id, !row.mute)}
      >M</button>
      <label class="kn" title="Gain {row.gain.toFixed(2)}">
        <input
          class="knob" type="range" min="0" max="2" step="0.01" value={row.gain}
          aria-label="Gain {row.name}" oninput={(e) => setRowGain(p, engine, track.id, row.id, vol(e))}
        />
        <span class="val">{row.gain.toFixed(2)}</span>
      </label>
      <label class="kn" title="Pan {panText(row.pan)}">
        <input
          class="knob" type="range" min="-1" max="1" step="0.01" value={row.pan}
          aria-label="Pan {row.name}" oninput={(e) => setRowPan(p, engine, track.id, row.id, vol(e))}
        />
        <span class="val">{panText(row.pan)}</span>
      </label>
      <div class="cells">
        {#each { length: pat.stepCount } as _, s (s)}
          {@const v = pat.steps[r][s]}
          <button
            class="cell"
            class:on={v > 0}
            class:beat={s % 4 === 0}
            class:group={s % 4 === 3 && s !== pat.stepCount - 1}
            class:playhead={s === playStep}
            style:--o={v > 0 ? 0.35 + (0.65 * v) / 127 : 1}
            data-testid="step-{r}-{s}"
            aria-label="Row {r + 1} step {s + 1}"
            aria-pressed={v > 0}
            onpointerdown={(e) => down(e, row.id, s, v)}
            onpointerenter={() => enter(row.id, s)}
          ></button>
        {/each}
      </div>
    </div>
  {/each}

  <div class="foot">
    <button
      class="add" class:over={dragOver === 'add'} data-testid="add-row"
      disabled={track.rows.length >= MAX_ROWS}
      onclick={() => addRow(p, engine, track.id)}
      ondragenter={(e) => { allow(e); dragOver = 'add'; }}
      ondragover={allow}
      ondragleave={() => dragOver === 'add' && (dragOver = null)}
      ondrop={dropOnAdd}
    >+ Add row</button>
    <label>Steps
      <select
        data-testid="step-count" value={pat.stepCount}
        onchange={(e) => setStepCount(p, engine, track.id, Number(e.currentTarget.value) as 16 | 32 | 64)}
      >
        <option value={16}>16</option><option value={32}>32</option><option value={64}>64</option>
      </select>
    </label>
    <label>Swing
      <input
        type="range" min="0" max="100" step="1" value={Math.round(pat.swing * 100)}
        data-testid="swing" style:accent-color={track.color} oninput={(e) => setSwing(p, engine, track.id, vol(e) / 100)}
      />
      <span class="pct">{Math.round(pat.swing * 100)}%</span>
    </label>
  </div>
</div>

<style>
  .grid { display: flex; flex-direction: column; gap: 3px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 3px; border: 1px dashed transparent; }
  .row.over, .add.over { border-color: var(--c); background: #24262c; }
  .name { width: 90px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e4e5ea; }
  .name.empty { color: #6a6d79; font-style: italic; }
  .mute { font: inherit; font-size: 10px; width: 22px; height: 22px; border: 0; border-radius: 3px; background: #2a2c33; color: #9a9ca8; cursor: pointer; }
  .mute.on { background: #f0a23a; color: #111; }
  .kn { display: flex; flex-direction: column; align-items: center; width: 64px; flex: none; }
  .knob { width: 56px; margin: 0; accent-color: var(--c); }
  .val { font-size: 9px; color: #7d808c; line-height: 1; }
  .hdr { display: flex; gap: 6px; padding: 0 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #6a6d79; }
  .hdr .name { color: #6a6d79; }
  .mute-h { width: 22px; flex: none; text-align: center; }
  .knob-h { width: 64px; flex: none; text-align: center; }
  .cells { display: flex; gap: 2px; flex: 1; min-width: 0; user-select: none; }
  .cell {
    flex: 1 1 0; min-width: 8px; max-width: 34px; height: 26px; padding: 0; border: 0; border-radius: 3px;
    background: #2a2c33; cursor: pointer; touch-action: none; position: relative;
  }
  .cell.beat:not(.on) { background: #34363f; }
  .cell.group { margin-right: 6px; }
  .cell.on { background: var(--c); opacity: var(--o); }
  .cell.playhead { box-shadow: inset 0 0 0 2px #fff; }
  .cell.playhead:not(.on) { background: #4a4d59; }
  .foot { display: flex; align-items: center; gap: 14px; margin-top: 6px; color: #9a9ca8; }
  .foot label { display: flex; align-items: center; gap: 6px; }
  .foot select { font: inherit; background: #24262c; color: #c9cbd3; border: 1px solid #2a2c33; border-radius: 3px; }
  .add { font: inherit; padding: 3px 10px; border: 1px dashed #3a3d47; border-radius: 3px; background: transparent; color: #c9cbd3; cursor: pointer; }
  .add:disabled { opacity: 0.4; cursor: not-allowed; }
  .pct { width: 32px; }
</style>
