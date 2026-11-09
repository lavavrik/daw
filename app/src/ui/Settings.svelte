<script lang="ts">
  // Audio settings (plan 22 Task 1): a MODAL dialog, opened from Options ▸
  // Audio settings…, View ▸ Performance and the top bar's warning badge
  // (dropouts, high latency). TopBar.svelte mounts it after its <header>.
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
  // Note names are NOT here (plan 22: every setting lives in one place):
  // Options ▸ Note names ▸ (MenuBar.svelte).
  //
  // WHY A MODAL (plan 22, the owner: "none of the dropdowns work"). It used
  // to sit in a <details> popover inside the top bar. Root cause: Chrome's
  // customizable select (`appearance: base-select`, theme.css) opens its
  // picker, but with the select inside an open <details> inside the bar
  // (`overflow-x: clip`) the picker was painted clipped to the bar's box:
  // invisible, and a click where an option should be landed on the panel's
  // readout under it (elementFromPoint = the <dd>). Either ancestor alone
  // was fine; the pair was not. Keyboard picks and Playwright's selectOption
  // set the value without the picker, so the e2e never saw it. A <dialog>
  // opened with showModal() is in the top layer, outside the bar, with no
  // <details>: settings.spec.ts opens the picker with a real click and picks.
  //
  // DIALOG RULES (as ShortcutsSheet.svelte): the browser traps the focus and
  // the page behind is inert; the focus starts on the latency select and
  // goes back to `returnFocus` (what opened it) on close. Esc, the × button
  // or a press on the backdrop close it. Every keydown inside stops here
  // (no piano, no Space, no Esc-ends-MIDI-learn behind a modal), ⌘S / ⌘O are
  // prevented (no browser "Save page" behind it). Esc that something inside
  // used (the select's open picker closes; NumberField reverting a typed
  // buffer) closes only that, never the dialog too. The native `cancel`
  // (Esc with the focus outside any control) goes through the same close.
  // The select keeps its focus after a pick (no releaseSelect: the piano
  // can't hear keys typed in a modal anyway).
  //
  // Look: tokens only; a --panel card with the lift, as the shortcuts sheet.
  import { onMount, untrack } from 'svelte';
  import type { AudioEngine, LatencyInfo } from '../audio/engine';
  import { BT_LATENCY_MS, CUSTOM_HINT_MAX_S, CUSTOM_HINT_MIN_S, customHint, hintLabel } from '../audio/restart';
  import type { LatencyHint } from '../audio/restart';
  import NumberField from './NumberField.svelte';
  import { selectKey } from './selectKey';
  import GearSix from 'phosphor-svelte/lib/GearSix';
  import X from 'phosphor-svelte/lib/X';
  import Icon from './Icon.svelte';

  let {
    engine,
    hint,
    busy = false,
    blocked = null,
    onApply,
    returnFocus = null,
    fallbackFocus = null,
    onclose,
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
    /** Where the focus goes when it closes (what opened it). */
    returnFocus?: HTMLElement | null;
    /** Where it goes when that is gone meanwhile (a badge that cleared itself): the Options menu button. */
    fallbackFocus?: HTMLElement | null;
    onclose: () => void;
  } = $props();

  let dlg = $state<HTMLDialogElement | null>(null);
  let first = $state<HTMLSelectElement | null>(null);
  function close() {
    dlg?.close(); // first: nothing outside an open modal can take the focus
    // Never <body>: the opener, else the fallback (both gone: the browser's choice).
    (returnFocus?.isConnected ? returnFocus : fallbackFocus?.isConnected ? fallbackFocus : null)?.focus();
    onclose();
  }
  function key(e: KeyboardEvent) {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyS' || e.code === 'KeyO')) e.preventDefault();
    if (e.key !== 'Escape') return;
    // An open picker (its Esc closes it) or a field that used the Esc: only that layer.
    // (With the picker open the key's target is the focused <option> inside it.)
    const sel = e.target instanceof Element ? e.target.closest('select') : null;
    if (e.defaultPrevented || sel?.matches(':open')) return;
    e.preventDefault();
    close();
  }
  function cancel(e: Event) {
    e.preventDefault(); // the native close skips onclose / the focus return
    close();
  }
  /** Only a press OUTSIDE the box (the backdrop): padding clicks target the <dialog> too. */
  function backdropPress(e: MouseEvent) {
    if (!dlg || e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  }

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
    dlg?.showModal();
    first?.focus();
    return () => dlg?.close();
  });
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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
<dialog
  bind:this={dlg} class="sheet" data-testid="settings" aria-labelledby="settings-title"
  onkeydown={key} oncancel={cancel} onclick={backdropPress}
>
  <header>
    <h2 id="settings-title">Audio settings</h2>
    <button class="x" aria-label="Close" title="Close (Esc)" onclick={close}><Icon icon={X} /></button>
  </header>
  <div class="settings">
    <label class="field">
      <span>Latency</span>
      <select data-testid="latency-hint" bind:this={first} bind:value={choice} disabled={busy} onkeydown={selectKey}>
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
        <Icon icon={GearSix} /> {busy ? 'Restarting…' : 'Apply'}
      </button>
      <span class="note">Restarts audio and stops playback; the project stays as it is.</span>
    </div>
    {#if blocked ?? status}
      <p class="status" data-testid="settings-status">{blocked ?? status}</p>
    {/if}
  </div>
</dialog>

<style>
  /* Tokens only: a --panel card with the lift, like the shortcuts sheet. */
  .sheet {
    width: min(340px, calc(100vw - 32px)); padding: 0; border: 0; overflow: visible;
    border-radius: var(--r-lg); background: var(--panel); color: var(--text); box-shadow: var(--lift);
    font: var(--fs-ctl) var(--font-ui);
  }
  .sheet::backdrop { background: color-mix(in srgb, var(--lcd) 55%, transparent); }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px 8px 16px; border-bottom: 1px solid var(--line);
  }
  h2 { margin: 0; font: 700 14px var(--font-ui); }
  .x {
    display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0;
    border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer;
  }
  .x:hover { background: var(--raised); }
  .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .settings { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 16px; white-space: normal; color: var(--text); }
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
