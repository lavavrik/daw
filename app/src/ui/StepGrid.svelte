<script lang="ts">
  // Step grid for one drum track: one line per row (name, mute, gain, pan,
  // step cells), plus add-row / step-count / swing controls. Rows accept
  // dropped audio files (Finder) and library samples (Browser pane). All
  // edits go through actions.ts (state + engine).
  //
  // Row waveform (plan 12): "≈" on a row with a sample opens a 72 px
  // waveform strip under the rows for that row (ui/vis/WaveformView: file
  // time, the whole file at first, zoomable to single samples). One row at a
  // time, not saved, display only. It draws no start/end/fade markers and no
  // playhead: drum rows have no such engine params yet and drum voices
  // report no position (follow-ups).
  //
  // Look (plan 20, spec §4): each row has its own colour, the palette walked
  // from the track's slot (stepGrid.ts rowColor; UI only). A cell's fill is
  // as tall as its velocity, velocity >= 110 adds the accent ring (the Acid
  // rule), and the playing step gets a white outline and a brighter fill;
  // stepGrid.ts stepCellStyle holds those rules. Gain and pan stay native
  // range inputs (skinned by theme.css): they are not rack params, so they
  // have no MIDI-learn or automation for the Knob slider variant to keep, and
  // a native drag is already one undo entry (history/gestures.ts).
  import { onDestroy, onMount } from 'svelte';
  import { registerDragCancel } from '../history/gestures';
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
  import { releaseSelect, selectKey } from './selectKey';
  import { deferSampleLoad } from '../state/sampleLoads';
  import { importSample } from '../state/sampleImport';
  import { bindPreview, previewState, togglePreview } from '../library/sharedPreview.svelte';
  import type { DrumTrack, Project } from '../state/project.svelte';
  import { fineRequestFor } from '../audio/fineSamples';
  import WaveformView from './vis/WaveformView.svelte';
  import { fileMap, waveBase } from './vis/waveMath';
  import { rowColor, stepCellStyle } from './stepGrid';
  import { rangeFill, rangeFillBipolar } from './rangeFill';

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

  // ---- row waveform -----------------------------------------------------
  /** The row whose strip is open (view state: not saved, not an edit). */
  let waveRowId = $state<string | null>(null);
  const waveRow = $derived.by(() => {
    void p.peaksVersion; // sampleMeta is a plain Map
    const r = track.rows.findIndex((x) => x.id === waveRowId);
    const row = track.rows[r];
    if (!row || row.sampleId === null) return null;
    const meta = p.sampleMeta.get(row.sampleId);
    if (!meta) return null;
    const base = waveBase(meta, engine.sampleRate);
    const f = p.sampleFiles.get(row.sampleId);
    const fine = f ? fineRequestFor(f, meta, engine.context) : null;
    return { r, row, sampleId: row.sampleId, base, map: fileMap(base.frames), fine };
  });

  /** The pattern being edited (steps, step count, swing); rows stay per track. */
  const pat = $derived(currentPattern(track));

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
</script>

<div class="grid">
  <div class="hdr" aria-hidden="true">
    <span class="lbl tag-h"></span><span class="lbl name-h">Sample</span><span class="wave-h"></span>
    <span class="lbl mute-h">Mute</span><span class="lbl gain-h">Gain</span><span class="lbl pan-h">Pan</span>
    <span class="lbl">Steps</span>
  </div>
  {#each track.rows as row, r (row.id)}
    {@const gain = rangeFill(row.gain / 2)}
    {@const pan = rangeFillBipolar((row.pan + 1) / 2)}
    <div
      class="row"
      class:over={dragOver === row.id}
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
        <span class="wave-h"></span>
      {:else}
        {@const sid = row.sampleId}
        {@const on = previewState.key === rowKey(sid)}
        <button
          type="button" class="name prev" class:on data-testid="row-name"
          title="{row.name} — click to preview{on ? ' (click again to stop)' : ''}"
          aria-label="Preview {row.name}" aria-pressed={on}
          onclick={() => void previewRow(sid, row.name)}
        >{row.name}</button>
        <button
          type="button" class="wave" class:on={waveRowId === row.id} data-testid="row-wave-btn-{r}"
          title="Waveform of {row.name}" aria-label="Waveform of {row.name}" aria-pressed={waveRowId === row.id}
          onclick={() => (waveRowId = waveRowId === row.id ? null : row.id)}
        >≈</button>
      {/if}
      <!-- The LED shows the row playing (lit) or muted (grey); pressed = muted. -->
      <button
        class="mute" class:on={row.mute} aria-pressed={row.mute}
        title="{row.mute ? 'Unmute' : 'Mute'} {row.name}" aria-label="Mute {row.name}"
        onclick={() => setRowMute(p, engine, track.id, row.id, !row.mute)}
      ></button>
      <label class="sl gain" title="Gain {row.gain.toFixed(2)}">
        <input
          type="range" min="0" max="2" step="0.01" value={row.gain} style:--fill={gain.fill}
          aria-label="Gain {row.name}" oninput={(e) => setRowGain(p, engine, track.id, row.id, vol(e))}
        />
        <span class="val mono">{row.gain.toFixed(2)}</span>
      </label>
      <label class="sl pan" title="Pan {panText(row.pan)}">
        <input
          type="range" min="-1" max="1" step="0.01" value={row.pan}
          style:--fill={pan.fill} style:--fill-pos={pan.pos}
          aria-label="Pan {row.name}" oninput={(e) => setRowPan(p, engine, track.id, row.id, vol(e))}
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
                onpointerdown={(e) => down(e, row.id, s, v)}
                oncontextmenu={(e) => e.preventDefault()}
                onpointerenter={() => enter(row.id, s)}
                onclick={(e) => e.detail === 0 && setStep(p, engine, track.id, row.id, s, v > 0 ? 0 : FULL)}
              >{#if st.on}<span class="fill" style:height="{st.fill}%"></span>{/if}</button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/each}

  {#if waveRow}
    {@const w = waveRow}
    <div class="strip">
      <span class="strip-name" title={w.row.name}>{w.row.name}</span>
      {#key `${w.row.id}:${w.sampleId}`}
        <WaveformView
          base={w.base} map={w.map} fine={w.fine} height={72} color={rowColor(track.slot, w.r)}
          testid="row-wave-{w.r}" label="Waveform of {w.row.name}"
        />
      {/key}
    </div>
  {/if}

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
    <label><span class="lbl">Steps</span>
      <select
        data-testid="step-count" value={pat.stepCount} onkeydown={selectKey}
        onchange={(e) => { setStepCount(p, engine, track.id, Number(e.currentTarget.value) as 16 | 32 | 64); releaseSelect(e.currentTarget); }}
      >
        <option value={16}>16</option><option value={32}>32</option><option value={64}>64</option>
      </select>
    </label>
    <label><span class="lbl">Swing</span>
      <input
        class="swing" type="range" min="0" max="100" step="1" value={Math.round(pat.swing * 100)}
        style:--fill={rangeFill(pat.swing).fill}
        data-testid="swing" oninput={(e) => setSwing(p, engine, track.id, vol(e) / 100)}
      />
      <span class="pct mono">{Math.round(pat.swing * 100)}%</span>
    </label>
  </div>
</div>

<style>
  /* Spec §4 "Step grid". Every colour is a theme.css token; a row's colour is
     data (ui/stepGrid.ts rowColor), passed in as --c on the row. Widths: the
     header's labels line up with the row's controls (tag 5, name 120,
     wave 18, mute 22, gain 104, pan 80; 8 px gaps). */
  .grid { display: flex; flex-direction: column; gap: 4px; }
  .hdr, .row { display: flex; align-items: center; gap: 8px; padding: 0 4px; }
  .hdr { height: 14px; }
  .tag-h { width: 5px; flex: none; }
  .name-h { width: 120px; flex: none; }
  /* "MUTE" is wider than the 22 px LED: centred, it overhangs both gaps evenly. */
  .mute-h { width: 22px; flex: none; display: flex; justify-content: center; }
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

  /* The name: a raised button (click previews); the ▶ / ■ glyph is CSS so the
     text stays the sample name. */
  .name {
    display: block; width: 120px; height: 30px; flex: none; box-sizing: border-box; padding: 0 10px;
    line-height: 30px; text-align: left; border-radius: var(--r-md);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font: 600 var(--fs-ctl) var(--font-ui); color: var(--text);
  }
  .name.prev {
    border: 0; cursor: pointer; position: relative; padding-right: 24px;
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow);
  }
  .name.prev:hover { filter: brightness(1.08); }
  .name.prev::after { content: '▶'; position: absolute; right: 10px; font-size: var(--fs-xs); color: var(--text-2); }
  .name.prev.on { color: var(--on-color); background-color: var(--play); }
  .name.prev.on::after { content: '■'; color: var(--on-color); }
  .name.prev:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .name.empty { line-height: 28px; border: 1px dashed var(--line); color: var(--text-2); font-weight: 400; font-style: italic; }

  .wave-h, .wave { width: 18px; flex: none; }
  .wave { font: inherit; height: 22px; padding: 0; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-2); cursor: pointer; }
  .wave:hover, .wave.on { color: var(--text); background: var(--raised); }
  .wave:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* Mute LED: lit (--play, glowing) while the row plays, grey when muted. */
  .mute {
    width: 22px; height: 22px; flex: none; padding: 0; border: 2px solid var(--well); border-radius: 50%;
    background: var(--play) var(--gloss);
    box-shadow: 0 0 10px color-mix(in srgb, var(--play) 40%, transparent);
    cursor: pointer;
  }
  .mute.on { background-color: var(--raised); box-shadow: none; }
  .mute:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Gain and pan: skinned native ranges (theme.css), filled in the row colour
     (--c inherits from the row); pan fills from the centre (--fill-pos). */
  .sl { display: flex; flex-direction: column; justify-content: center; gap: 1px; flex: none; }
  .sl.gain { width: 104px; }
  .sl.pan { width: 80px; }
  .sl input { width: 100%; }
  .val { font-size: var(--fs-xs); line-height: 1; color: var(--text-2); text-align: center; }

  /* Steps: groups of 4, 12 px apart. */
  .cells { display: flex; gap: 12px; flex: 1; min-width: 0; user-select: none; }
  .grp { display: flex; gap: 3px; flex: 1 1 0; min-width: 0; max-width: 156px; }
  .cell {
    flex: 1 1 0; min-width: 7px; height: 30px; padding: 0; border: 0; position: relative; overflow: hidden;
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

  .strip { display: flex; align-items: center; gap: 8px; padding: 2px 4px; }
  .strip-name { width: 133px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }

  .foot { display: flex; align-items: center; gap: 12px; margin-top: 6px; padding: 0 4px; color: var(--text-2); }
  .foot label { display: flex; align-items: center; gap: 8px; }
  .add { padding: 4px 12px; }
  .swing { width: 160px; }
  .pct { width: 32px; color: var(--text); }
</style>
