<script lang="ts">
  // "+ Add track" (plan 21 §8): the playlist footer's one add button. It
  // opens a plain list (Drum, Synth, Sampler, Audio track; Master row): the
  // same items, actions and disabled reasons as the menu bar's Add menu
  // (ui/addTrack.ts runs both). Each item keeps the test id of the footer
  // button it replaced (`add-drum-track`, `add-synth-track`,
  // `add-sampler-track`, `add-audio-track`, and `tl-master-toggle` for the
  // Master row), so a test opens the menu (tests/e2e/addTrack.ts) and clicks
  // it. A full project (MAX_TRACKS) disables the track items with the reason
  // as their tooltip; the Master row item is gone once the row has a lane
  // (it stays then), and disabled while it is shown without one (its header's
  // × hides it).
  //
  // Keyboard (spec §1's menu rule: an `aria-expanded` button over a list of
  // plain buttons, no role=menu): opening focuses the first enabled item,
  // Up / Down / Home / End move, Escape closes and gives the focus back to
  // the button (and is stopped: only the topmost layer closes), a click
  // outside closes. ↓ / ↑ on the closed button open the list on its first /
  // last item (like a menu-bar button). Every other key typed in the list
  // stays there (like MenuBar's keepKey): Space / Enter press the focused
  // item natively and never also start the song, letters never play notes
  // or arm recording; only Escape and Cmd / Ctrl chords (⌘S, ⌘Z) still
  // reach the global shortcuts on window. The list is position: fixed above the button, so the
  // song pane's overflow never clips it. When the top of the list would be
  // covered there (a short song pane: the top bar sits over it, the footer's
  // stacking context is under the bar), it opens below the button instead.
  //
  // Under "Drum track" (plan 25 Task 1): a kit choice, one chip per built-in
  // kit (state/kits.ts KITS, the Starter kit first; chips, not rows, so the
  // list stays short enough to fit above the button), test ids
  // `add-drum-kit-<kit id>`. It adds a drum track made of that kit: its rows
  // are the roles (Kick, Clap, …), each with the kit's sound, named after
  // the kit (state/kit-actions.ts addKitDrumTrack: one undo entry; the track
  // appears once its samples are in, a moment later). "Drum track" itself
  // still adds the plain track with four empty rows.
  //
  // Dropping a sample (a Finder file or a library sample) on the button makes
  // a Sampler track with it, as the old "+ Sampler track" button did.
  import Plus from 'phosphor-svelte/lib/Plus';
  import GridFour from 'phosphor-svelte/lib/GridFour';
  import PianoKeys from 'phosphor-svelte/lib/PianoKeys';
  import Waveform from 'phosphor-svelte/lib/Waveform';
  import FileAudio from 'phosphor-svelte/lib/FileAudio';
  import FadersHorizontal from 'phosphor-svelte/lib/FadersHorizontal';
  import type { Component } from 'svelte';
  import Icon from '../Icon.svelte';
  import type { Project } from '../../state/project.svelte';
  import { MAX_TRACKS } from '../../state/project.svelte';
  import type { CommandSink } from '../../state/actions';
  import type { ImportEngine } from '../../state/sampleImport';
  import { addSamplerTrack } from '../../state/sampler-actions';
  import { KITS, STARTER_KIT_ID } from '../../state/kits';
  import { addKitDrumTrack } from '../../state/kit-actions';
  import { banners } from '../../state/banners.svelte';
  import { droppedFiles, isSampleDrag } from '../../library/drag';
  import { ADD_ITEMS, addBlocked, addTrack } from '../addTrack';
  import type { AddKind } from '../addTrack';

  let { p, engine, onhint }: { p: Project; engine: CommandSink & ImportEngine; onhint: (text: string) => void } = $props();

  /** Each item's old footer test id and its icon. */
  const ITEM: Record<AddKind, { testid: string; icon: Component<any> }> = {
    drum: { testid: 'add-drum-track', icon: GridFour },
    synth: { testid: 'add-synth-track', icon: PianoKeys },
    sampler: { testid: 'add-sampler-track', icon: Waveform },
    audio: { testid: 'add-audio-track', icon: FileAudio },
    master: { testid: 'tl-master-toggle', icon: FadersHorizontal },
  };
  /** The Master row item only while the row has no lane (with a lane it stays: nothing to toggle). */
  const items = $derived(ADD_ITEMS.filter((it) => it.kind !== 'master' || !p.mixer.automation.length));
  const tracksFull = $derived(p.tracks.length >= MAX_TRACKS);

  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  /**
   * Where the list sits (fixed, viewport px): its left edge and either its
   * bottom 4 px above the button or (`below`) its top 4 px under it.
   */
  let at = $state({ left: 0, bottom: 0, below: false, top: 0 });

  const buttons = () => [...(list?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];

  function show(focus: 'first' | 'last' = 'first') {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    at = { left: r.left, bottom: window.innerHeight - r.top + 4, below: false, top: r.bottom + 4 };
    open = true;
    queueMicrotask(() => {
      // Its top covered (or off screen) above the button: open below it.
      const lr = list?.getBoundingClientRect();
      const hit = lr && document.elementFromPoint(lr.left + 8, lr.top + 4);
      if (lr && (lr.top < 0 || !hit || !list!.contains(hit))) at = { ...at, below: true };
      const bs = buttons();
      bs[focus === 'first' ? 0 : bs.length - 1]?.focus();
    });
  }
  /** ↓ / ↑ on the button open the list on its first / last item (or move there when open). */
  function btnKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    show(e.key === 'ArrowDown' ? 'first' : 'last');
  }
  function close(refocus: boolean) {
    open = false;
    if (refocus) btn?.focus();
  }
  function pick(kind: AddKind) {
    close(false);
    addTrack(p, engine, kind);
  }
  /** A kit's drum track is being made (its samples load first): no second one meanwhile. */
  let addingKit = $state(false);
  async function pickKit(kitId: string) {
    close(false);
    addingKit = true;
    try {
      await addKitDrumTrack(p, engine, kitId);
    } finally {
      addingKit = false;
    }
  }

  function listKey(e: KeyboardEvent) {
    // Keys stay in the list (see the header); Escape is handled below.
    if (e.key !== 'Escape' && !e.metaKey && !e.ctrlKey) e.stopPropagation();
    const bs = buttons();
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    const go = (k: number) => {
      e.preventDefault();
      bs[(k + bs.length) % bs.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // only this layer closes
      close(true);
    } else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(-1);
    else if (e.key === 'Tab') close(false); // the focus moves on: the list goes
  }

  // A press outside the button and the list closes it; so does a resize (the list is placed once).
  $effect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn?.contains(t) && !list?.contains(t)) close(false);
    };
    const resize = () => close(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', resize);
    };
  });

  // ---- a sample dropped on the button: a Sampler track with it ------------------
  let over = $state(false);
  function dragOver(e: DragEvent) {
    if (!isSampleDrag(e) || p.loading || tracksFull) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    over = true;
  }
  function drop(e: DragEvent) {
    if (!isSampleDrag(e)) return;
    e.preventDefault(); // handled here, never the window's "drop onto a row" error
    e.stopPropagation(); // nor the timeline's audio drop
    over = false;
    if (p.loading || tracksFull) return;
    const pending = droppedFiles(e); // synchronously: the DataTransfer empties once this returns
    void (async () => {
      let files: File[];
      try {
        files = await pending;
      } catch (err) {
        banners.error = err instanceof Error ? err.message : String(err);
        return;
      }
      if (!files[0]) return;
      if (files.length > 1) onhint('A sampler track takes one sample: using the first');
      await addSamplerTrack(p, engine, files[0]);
    })();
  }
</script>

<button
  bind:this={btn}
  class="btn add"
  class:over
  data-testid="add-track"
  aria-expanded={open}
  aria-haspopup="true"
  title="Add a track or the Master row. Drop a sample here for a Sampler track"
  onclick={() => (open ? close(false) : show())}
  onkeydown={btnKey}
  ondragover={dragOver}
  ondragleave={() => (over = false)}
  ondrop={drop}
><Icon icon={Plus} size={14} />Add track</button>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="list" bind:this={list} data-testid="add-track-menu" style:left="{at.left}px" style:bottom={at.below ? null : `${at.bottom}px`} style:top={at.below ? `${at.top}px` : null} style:--room="{at.below ? window.innerHeight - at.top : window.innerHeight - at.bottom}px" onkeydown={listKey}>
    {#each items as it (it.kind)}
      {@const why = addBlocked(p, it.kind)}
      <button data-testid={ITEM[it.kind].testid} disabled={!!why} title={why ?? it.title} onclick={() => pick(it.kind)}>
        <Icon icon={ITEM[it.kind].icon} />{it.label}
      </button>
      {#if it.kind === 'drum'}
        <div class="kits" role="group" aria-label="Drum track with a kit">
          {#each KITS as k (k.id)}
            <button
              class="kit" data-testid="add-drum-kit-{k.id}" disabled={!!why || addingKit}
              title={why ?? `Add a drum track with the ${k.name} kit — ${k.blurb}`} onclick={() => void pickKit(k.id)}
            >{k.id === STARTER_KIT_ID ? 'Starter' : k.name}</button>
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* A footer pill (Timeline's .foot .btn size), icon + text. */
  .add { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-size: 11px; }
  .add.over { box-shadow: var(--raised-shadow), 0 0 0 2px var(--accent); }
  .list { position: fixed; z-index: 50; min-width: 170px; max-height: calc(var(--room, 100vh) - 8px); overflow-y: auto; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift); display: flex; flex-direction: column; }
  .list button { display: flex; align-items: center; gap: 8px; font: var(--fs-ctl) var(--font-ui); text-align: left; padding: 5px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer; }
  .list button:hover:not(:disabled), .list button:focus-visible { background: var(--raised); outline: none; }
  .list button:disabled { color: var(--text-2); opacity: 0.5; cursor: not-allowed; }
  /* The kit choice under "Drum track": small chips, indented under its label. */
  .kits { display: flex; flex-wrap: wrap; gap: 3px; padding: 0 6px 4px 28px; max-width: 200px; }
  .list .kits button.kit { padding: 1px 6px; font-size: var(--fs-lbl); color: var(--text-2); border: 1px solid var(--line); }
  .list .kits button.kit:hover:not(:disabled), .list .kits button.kit:focus-visible { color: var(--text); border-color: var(--accent); }
</style>
