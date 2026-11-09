<script lang="ts">
  // The MIDI popover (plan 14 Task 4; docs/architecture/midi.md "The popover").
  // Non-modal, like the piano roll's Examples popover: Esc, a pointer press
  // outside, or focus moving away closes it (`onclose`). Three sections:
  // Devices, Last CC, Mappings (with a forget button per row: one undo
  // entry, "Forget MIDI CC n").
  // Opened from Options ▸ MIDI… (MenuBar.svelte; under the Options button)
  // or the top bar's "MIDI blocked" badge (under the badge, which toggles
  // it). Plan 22 removed the MIDI pill it used to hang from, so it places
  // itself: fixed, 6 px under `anchor`, aligned to the anchor's left edge in
  // the left half of the window and to its right edge in the right half
  // (it never runs off screen). TopBar renders it after its <header>.
  // Look (plan 20 Task 5): a --panel card with --lift.
  import { onMount, tick } from 'svelte';
  import type { MidiStatus } from '../input/midi';
  import { forgetMidi, mappingLabel } from '../state/midiMap';
  import type { Project } from '../state/project.svelte';

  let { p, status, cc, anchor, toggle = null, returnFocus = null, onclose }: {
    p: Project;
    status: MidiStatus;
    /** The last CC received (any channel), or null before the first. */
    cc: { cc: number; v: number } | null;
    /** What it opens under (the Options button, the badge). */
    anchor: HTMLElement | null;
    /** What toggles it (the badge): presses on it are not "outside". */
    toggle?: HTMLElement | null;
    /** Where Esc puts the focus (what opened it); default the anchor. */
    returnFocus?: HTMLElement | null;
    onclose: () => void;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  /** Fixed position from the anchor (see the header); re-placed on resize. */
  let pos = $state<{ top: number; left: number | null; right: number | null }>({ top: 0, left: 0, right: null });
  function place() {
    const r = anchor?.getBoundingClientRect();
    if (!r) return;
    const rightHalf = r.left + r.width / 2 > innerWidth / 2;
    pos = { top: r.bottom + 6, left: rightHalf ? null : Math.max(8, r.left), right: rightHalf ? Math.max(8, innerWidth - r.right) : null };
  }
  onMount(() => {
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  });

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
    if (!to || root?.contains(to) || toggle?.contains(to)) return;
    onclose();
  }
  function forget(m: (typeof rows)[number]) {
    forgetMidi(p, m.owner, m.target);
    root?.focus(); // the pressed button is gone: keep focus inside
  }

  $effect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root?.contains(t) && !toggle?.contains(t)) onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    void tick().then(() => root?.focus());
    return () => window.removeEventListener('pointerdown', outside, true);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="pop" role="dialog" aria-label="MIDI" tabindex="-1" data-testid="midi-popover" bind:this={root} onkeydown={key} onfocusout={focusOut}
  style:top="{pos.top}px" style:left={pos.left === null ? null : `${pos.left}px`} style:right={pos.right === null ? null : `${pos.right}px`}
>
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
  .pop { position: fixed; z-index: 20; min-width: 240px; max-width: 360px; max-height: 60vh; overflow-y: auto; padding: 8px 10px; background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); text-align: left; white-space: normal; font: var(--fs-ctl) var(--font-ui); color: var(--text); outline: none; }
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
