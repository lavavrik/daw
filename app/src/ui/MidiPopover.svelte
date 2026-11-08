<script lang="ts">
  // The MIDI popover (plan 14 Task 4; docs/architecture/midi.md "The popover"):
  // opened from the top bar's MIDI pill. Non-modal, like the piano roll's
  // Examples popover: Esc, a pointer press outside, or focus moving away
  // closes it (`onclose`). Three sections: Devices, Last CC, Mappings (with
  // a forget button per row: one undo entry, "Forget MIDI CC n").
  // Look (plan 20 Task 5): a --panel card with --lift; it opens leftwards
  // from the pill (right-aligned), as the pill is at the bar's right end.
  // Options ▸ MIDI… (MenuBar.svelte, plan 21) opens it too, still under the
  // pill; then Esc gives the focus back to the Options menu button
  // (`returnFocus`) instead of the pill.
  import { tick } from 'svelte';
  import type { MidiStatus } from '../input/midi';
  import { forgetMidi, mappingLabel } from '../state/midiMap';
  import type { Project } from '../state/project.svelte';

  let { p, status, cc, anchor, returnFocus = null, onclose }: {
    p: Project;
    status: MidiStatus;
    /** The last CC received (any channel), or null before the first. */
    cc: { cc: number; v: number } | null;
    /** The pill that opened it: presses on it are its own toggle, not "outside". */
    anchor: HTMLElement | null;
    /** Where Esc puts the focus (what opened it); default the pill. */
    returnFocus?: HTMLElement | null;
    onclose: () => void;
  } = $props();

  let root = $state<HTMLElement | null>(null);

  const statusText = $derived(
    status.state === 'denied' ? 'MIDI access was denied by the browser'
    : status.state === 'unsupported' ? 'This browser has no Web MIDI'
    : 'No MIDI devices connected',
  );
  const rows = $derived([...p.midiMap].sort((a, b) => a.cc - b.cc));

  function key(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // not also "cancel learn" etc.
    onclose();
    (returnFocus ?? anchor)?.focus();
  }
  /** Focus left the popover (Tab out): close. Focus to the pill is its own toggle; null = window blur / non-focusable click (the pointer handler decides). */
  function focusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (!to || root?.contains(to) || anchor?.contains(to)) return;
    onclose();
  }
  function forget(m: (typeof rows)[number]) {
    forgetMidi(p, m.owner, m.target);
    root?.focus(); // the pressed button is gone: keep focus inside
  }

  $effect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root?.contains(t) && !anchor?.contains(t)) onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    void tick().then(() => root?.focus());
    return () => window.removeEventListener('pointerdown', outside, true);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="pop" role="dialog" aria-label="MIDI" tabindex="-1" data-testid="midi-popover" bind:this={root} onkeydown={key} onfocusout={focusOut}>
  <h4>Devices</h4>
  {#if status.state === 'connected'}
    <ul data-testid="midi-devices">{#each status.devices as d (d)}<li>{d}</li>{/each}</ul>
  {:else}
    <p data-testid="midi-devices">{statusText}</p>
  {/if}
  <h4>Last CC</h4>
  <p data-testid="midi-last-cc">{cc ? `CC ${cc.cc} = ${cc.v}` : 'Move a knob on your controller'}</p>
  <h4>Mappings</h4>
  {#if rows.length}
    <ul class="maps">
      {#each rows as m (m.cc)}
        <li data-testid={`midi-map-${m.cc}`}>
          <span class="lbl">CC {m.cc} → {mappingLabel(p, m)}</span>
          <button aria-label={`Forget CC ${m.cc}`} title="Forget this mapping" onclick={() => forget(m)}>✕</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="dim">Right-click a knob → MIDI learn</p>
  {/if}
</div>

<style>
  .pop { position: absolute; z-index: 20; top: calc(100% + 6px); right: 0; min-width: 240px; max-width: 360px; max-height: 60vh; overflow-y: auto; padding: 8px 10px; background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); text-align: left; white-space: normal; font: var(--fs-ctl) var(--font-ui); color: var(--text); outline: none; }
  h4 { margin: 8px 0 3px; padding-bottom: 2px; border-bottom: 1px solid var(--line); font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  h4:first-child { margin-top: 0; }
  p { margin: 2px 0; }
  .dim { color: var(--text-2); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 1px 0; }
  .maps li { display: flex; align-items: center; gap: 6px; }
  .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .maps button { flex: none; padding: 0 6px; font: inherit; line-height: 1.5; color: var(--text); background: var(--raised) var(--gloss); border: 0; border-radius: var(--r-sm); box-shadow: var(--raised-shadow); cursor: pointer; }
  .maps button:hover { filter: brightness(1.08); }
  .maps button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
