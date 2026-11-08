<script lang="ts">
  // Audio settings panel (opened from the top bar's ⚙ latency readout).
  //
  // - Latency hint: Interactive (lowest; the default), Balanced, Playback
  //   (largest buffers, most robust), or a custom buffer length (entered in
  //   ms, used as seconds: AudioContextOptions.latencyHint). The browser
  //   rounds it to what the device supports; the readout shows what it chose.
  // - Readout (4 Hz while open): sample rate, base latency (the context's own
  //   buffering), output latency (device + OS; Chrome may report 0 for a
  //   moment after a start) and their total -- the delay between a key press
  //   and hearing it, which the recorder already compensates for.
  // - The Bluetooth hint: wireless output adds 100–300 ms that no buffer
  //   setting removes; highlighted when the total is over 40 ms.
  // - Apply re-creates the AudioContext and engine (audio/restart.ts): the
  //   transport stops, the project stays as it is in memory (no reload),
  //   and the hint is remembered for the next start. Apply with the same
  //   hint is allowed: a new context also picks up a changed default output
  //   device.
  //
  // Look (plan 20 Task 5): tokens only; it sits in the top bar's --panel
  // popover. The select and the buffer field are the theme's skins.
  import { onMount, untrack } from 'svelte';
  import type { AudioEngine, LatencyInfo } from '../audio/engine';
  import { BT_LATENCY_MS, CUSTOM_HINT_MAX_S, CUSTOM_HINT_MIN_S, customHint, hintLabel } from '../audio/restart';
  import type { LatencyHint } from '../audio/restart';
  import NumberField from './NumberField.svelte';
  import { releaseSelect, selectKey } from './selectKey';

  let {
    engine,
    hint,
    busy = false,
    blocked = null,
    onApply,
  }: {
    engine: AudioEngine;
    /** The hint the running engine has. */
    hint: LatencyHint;
    /** A restart or a project load is running. */
    busy?: boolean;
    /** Why Apply cannot run now (an export), or null. */
    blocked?: string | null;
    /** Restart with this hint; resolves with why it did not run, or null. */
    onApply: (hint: LatencyHint) => Promise<string | null>;
  } = $props();

  type Choice = 'interactive' | 'balanced' | 'playback' | 'custom';
  // Seeded from the running hint once: the panel mounts each time it opens.
  const start = untrack(() => hint);
  let choice = $state<Choice>(typeof start === 'number' ? 'custom' : start);
  let customMs = $state<number | null>(Math.round((typeof start === 'number' ? start : 0.02) * 1000));
  let info = $state<LatencyInfo | null>(null);
  let status = $state<string | null>(null);

  /** What Apply would start with; null: the custom field holds nothing usable (Apply is disabled). */
  const wanted = $derived<LatencyHint | null>(choice === 'custom' ? customHint(customMs) : choice);
  const bt = $derived(info !== null && info.totalMs > BT_LATENCY_MS);

  onMount(() => {
    const read = () => (info = engine.latencyInfo());
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
  });

  async function apply() {
    if (wanted === null) return;
    status = null;
    status = await onApply(wanted);
  }

  const ms = (v: number) => `${v.toFixed(1)} ms`;
</script>

<div class="settings" data-testid="settings" role="group" aria-label="Audio settings">
  <div class="title lbl">Audio</div>
  <label class="field">
    <span>Latency</span>
    <select data-testid="latency-hint" bind:value={choice} disabled={busy} onkeydown={selectKey} onchange={(e) => releaseSelect(e.currentTarget)}>
      <option value="interactive">Interactive (lowest)</option>
      <option value="balanced">Balanced</option>
      <option value="playback">Playback (most stable)</option>
      <option value="custom">Custom…</option>
    </select>
  </label>
  {#if choice === 'custom'}
    <div class="field">
      <span>Buffer</span>
      <NumberField
        testid="latency-custom" ariaLabel="Buffer (ms)" unit="ms" disabled={busy}
        min={CUSTOM_HINT_MIN_S * 1000} max={CUSTOM_HINT_MAX_S * 1000} step={1}
        value={customMs} oninput={(v) => (customMs = v)} onchange={(v) => (customMs = v)}
      />
      <span class="applies" class:bad={wanted === null} data-testid="latency-applies">
        {wanted === null ? `Enter ${CUSTOM_HINT_MIN_S * 1000}–${CUSTOM_HINT_MAX_S * 1000} ms` : `Applies ${hintLabel(wanted)}`}
      </span>
    </div>
  {/if}
  <dl class="readout" title="What the browser chose for the running audio ({hintLabel(hint)})">
    <dt>Sample rate</dt><dd data-testid="settings-rate">{info ? `${info.sampleRate / 1000} kHz` : '—'}</dd>
    <dt>Base latency</dt><dd data-testid="settings-base">{info ? ms(info.baseMs) : '—'}</dd>
    <dt>Output latency</dt><dd data-testid="settings-output">{info ? ms(info.outputMs) : '—'}</dd>
    <dt>Total</dt><dd class="total" class:bad={bt} data-testid="settings-total">{info ? ms(info.totalMs) : '—'}</dd>
  </dl>
  <p class="bt" class:on={bt} data-testid="settings-bt">
    {#if bt}High output latency — Bluetooth headphones? Use wired output for playing live; no buffer setting removes it.
    {:else}Bluetooth headphones add 100–300 ms that no setting here removes: play live with wired output.{/if}
  </p>
  <div class="actions">
    <button class="btn primary" data-testid="settings-apply" disabled={busy || blocked !== null || wanted === null} onclick={() => void apply()}>
      {busy ? 'Restarting…' : 'Apply'}
    </button>
    <span class="note">Restarts audio and stops playback; the project stays as it is.</span>
  </div>
  {#if blocked ?? status}
    <p class="status" data-testid="settings-status">{blocked ?? status}</p>
  {/if}
</div>

<style>
  .settings { display: flex; flex-direction: column; gap: 8px; white-space: normal; color: var(--text); }
  .field { display: flex; align-items: center; gap: 6px; }
  .field > span { width: 52px; color: var(--text-2); font-size: 11px; }
  select { flex: 1; }
  .readout { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 2px 0 0; padding: 6px 8px; border-radius: var(--r-md); background: var(--lcd); box-shadow: var(--well-shadow); font-size: 11px; }
  .readout dt { color: var(--text-dim); }
  .readout dd { margin: 0; text-align: right; color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .readout .total { font-weight: 700; }
  .readout .total.bad { color: var(--accent); }
  .bt { margin: 0; font-size: 11px; color: var(--text-2); }
  .bt.on { color: var(--accent); }
  .actions { display: flex; align-items: center; gap: 8px; }
  .note { font-size: var(--fs-lbl); color: var(--text-2); }
  .applies { font-size: var(--fs-lbl); color: var(--text-2); }
  .applies.bad { color: var(--accent); }
  .status { margin: 0; font-size: 11px; color: var(--accent); }
</style>
