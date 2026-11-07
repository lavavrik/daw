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
  import { onMount, untrack } from 'svelte';
  import type { AudioEngine, LatencyInfo } from '../audio/engine';
  import { BT_LATENCY_MS, CUSTOM_HINT_MAX_S, CUSTOM_HINT_MIN_S, customHint, hintLabel } from '../audio/restart';
  import type { LatencyHint } from '../audio/restart';

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
  let customMs = $state(Math.round((typeof start === 'number' ? start : 0.02) * 1000));
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
  <div class="title">AUDIO</div>
  <label class="field">
    <span>Latency</span>
    <select data-testid="latency-hint" bind:value={choice} disabled={busy}>
      <option value="interactive">Interactive (lowest)</option>
      <option value="balanced">Balanced</option>
      <option value="playback">Playback (most stable)</option>
      <option value="custom">Custom…</option>
    </select>
  </label>
  {#if choice === 'custom'}
    <label class="field">
      <span>Buffer</span>
      <input
        type="number" data-testid="latency-custom" disabled={busy}
        min={CUSTOM_HINT_MIN_S * 1000} max={CUSTOM_HINT_MAX_S * 1000} step="1"
        bind:value={customMs}
      /> ms
      <span class="applies" class:bad={wanted === null} data-testid="latency-applies">
        {wanted === null ? `Enter ${CUSTOM_HINT_MIN_S * 1000}–${CUSTOM_HINT_MAX_S * 1000} ms` : `Applies ${hintLabel(wanted)}`}
      </span>
    </label>
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
    <button class="ok" data-testid="settings-apply" disabled={busy || blocked !== null || wanted === null} onclick={() => void apply()}>
      {busy ? 'Restarting…' : 'Apply'}
    </button>
    <span class="note">Restarts audio and stops playback; the project stays as it is.</span>
  </div>
  {#if blocked ?? status}
    <p class="status" data-testid="settings-status">{blocked ?? status}</p>
  {/if}
</div>

<style>
  .settings { display: flex; flex-direction: column; gap: 6px; white-space: normal; }
  .title { font-size: 10px; letter-spacing: 0.06em; color: #7d808c; }
  .field { display: flex; align-items: center; gap: 6px; }
  .field > span { width: 52px; color: #9a9da8; font-size: 11px; }
  select { font: inherit; color: #c9cbd3; background: #2a2c33; border: 1px solid #34363e; border-radius: 4px; padding: 3px 4px; flex: 1; }
  input { width: 56px; }
  .readout { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 2px 0 0; font-size: 11px; font-variant-numeric: tabular-nums; }
  .readout dt { color: #7d808c; }
  .readout dd { margin: 0; text-align: right; color: #c9cbd3; }
  .readout .total { font-weight: 600; }
  .readout .total.bad { color: #f0a23a; }
  .bt { margin: 0; font-size: 11px; color: #7d808c; }
  .bt.on { color: #f0a23a; }
  .actions { display: flex; align-items: center; gap: 8px; }
  .actions .ok { background: #f0a23a; color: #111; border-color: #f0a23a; font-weight: 600; }
  .note { font-size: 10px; color: #7d808c; }
  .applies { font-size: 10px; color: #7d808c; }
  .applies.bad { color: #f0a23a; }
  .status { margin: 0; font-size: 11px; color: #f0a23a; }
</style>
