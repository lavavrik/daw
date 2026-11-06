<script lang="ts">
  // Step grid for one drum track: one line per row (name, mute, gain, pan,
  // step cells), plus add-row / step-count / swing controls. Rows accept
  // dropped audio files. All edits go through actions.ts (state + engine).
  import { onMount } from 'svelte';
  import { Err, TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import { decodeFile, isProbablyAudio } from '../audio/samples';
  import {
    addRow, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setStepCount, setSwing,
  } from '../state/actions';
  import { MAX_ROWS } from '../state/project.svelte';
  import type { DrumTrack, Project } from '../state/project.svelte';

  let { p, engine, track, onerror, onnotice }: {
    p: Project;
    engine: AudioEngine;
    track: DrumTrack;
    onerror: (msg: string | null) => void;
    onnotice: (msg: string | null) => void;
  } = $props();

  const MAX_SAMPLES = 256; // engine MAX_SAMPLES
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
      const next = t[TELEMETRY.playing] === 1
        ? Math.floor((t[TELEMETRY.ticks] % (track.stepCount * 240)) / 240)
        : -1;
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
  /** Deferred loads: sample id -> where to attach it once the worklet has it. */
  const pending = new Map<number, { rowId: string; name: string }>();
  let dragOver = $state<string | null>(null); // row id, or 'add'

  $effect(() => {
    engine.onSampleLoaded = (id) => {
      const w = pending.get(id);
      if (!w) return;
      pending.delete(id);
      setRowSample(p, engine, track.id, w.rowId, id, w.name);
      onnotice(null);
    };
    return () => (engine.onSampleLoaded = undefined);
  });

  async function loadInto(file: File, rowId: string) {
    const fail = () => onerror(`Couldn't load "${file.name}" — not a readable audio file`);
    if (!isProbablyAudio(file)) return fail();
    let decoded;
    try {
      decoded = await decodeFile(file, engine.context);
    } catch {
      return fail();
    }
    if (p.nextSampleId >= MAX_SAMPLES) return onerror('Sample limit reached (256)');
    const id = p.nextSampleId++;
    const code = await engine.loadSample(id, decoded.channels);
    if (code === Err.OK) {
      setRowSample(p, engine, track.id, rowId, id, decoded.name);
      onerror(null);
    } else if (code === Err.DEFERRED) {
      pending.set(id, { rowId, name: decoded.name });
      onnotice(`"${decoded.name}" will load when playback stops`);
    } else {
      onerror(`Couldn't load "${file.name}" — engine rejected the sample (code ${code})`);
    }
  }

  function dropOnRow(e: DragEvent, rowId: string) {
    e.preventDefault();
    dragOver = null;
    const file = e.dataTransfer?.files[0];
    if (file) void loadInto(file, rowId);
  }
  function dropOnAdd(e: DragEvent) {
    e.preventDefault();
    dragOver = null;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const row = addRow(p, engine, track.id);
    if (!row) return onerror(`Row limit reached (${MAX_ROWS})`);
    void loadInto(file, row.id);
  }
  const allow = (e: DragEvent) => e.preventDefault();

  const vol = (e: Event) => (e.currentTarget as HTMLInputElement).valueAsNumber;
</script>

<div class="grid" style:--c={track.color}>
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
        class="mute" class:on={row.mute} aria-pressed={row.mute} title="Mute"
        onclick={() => setRowMute(p, engine, track.id, row.id, !row.mute)}
      >M</button>
      <input
        class="knob" type="range" min="0" max="2" step="0.01" value={row.gain} title="Gain"
        aria-label="Gain row {r + 1}" oninput={(e) => setRowGain(p, engine, track.id, row.id, vol(e))}
      />
      <input
        class="knob" type="range" min="-1" max="1" step="0.01" value={row.pan} title="Pan"
        aria-label="Pan row {r + 1}" oninput={(e) => setRowPan(p, engine, track.id, row.id, vol(e))}
      />
      <div class="cells">
        {#each { length: track.stepCount } as _, s (s)}
          {@const v = row.steps[s]}
          <button
            class="cell"
            class:on={v > 0}
            class:beat={s % 4 === 0}
            class:group={s % 4 === 3 && s !== track.stepCount - 1}
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
        data-testid="step-count" value={track.stepCount}
        onchange={(e) => setStepCount(p, engine, track.id, Number(e.currentTarget.value) as 16 | 32 | 64)}
      >
        <option value={16}>16</option><option value={32}>32</option><option value={64}>64</option>
      </select>
    </label>
    <label>Swing
      <input
        type="range" min="0" max="100" step="1" value={Math.round(track.swing * 100)}
        data-testid="swing" oninput={(e) => setSwing(p, engine, track.id, vol(e) / 100)}
      />
      <span class="pct">{Math.round(track.swing * 100)}%</span>
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
  .knob { width: 56px; flex: none; accent-color: var(--c); }
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
