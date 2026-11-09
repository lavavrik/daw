<script lang="ts">
  // The "Key ▾" popover (plan 26 Task 1; docs/architecture/theory.md): every
  // key tool in one card, so the roll's toolbar keeps its labels at 1280 px
  // (Task 1 review #2/#3):
  //   - root (12 pitch classes, named in the Note names style) and scale
  //     selects: each pick is setKey at once (one "Key" undo entry);
  //   - Snap to key (a toggle, a saved UI pref; the Key button shows a
  //     magnet badge while it is on);
  //   - Transpose… (expands TransposeCard: ±12 semitones, Apply);
  //   - Fit to key, labelled with its target like Quantize ("Fit 1 sel." /
  //     "Fit all"; disabled when nothing it acts on is out of key).
  // Transpose and Fit act on the selection, or every note. The card stays
  // open after each action (a key, Snap and a Fit are often used together);
  // Esc or a press outside closes it.
  import Magnet from 'phosphor-svelte/lib/Magnet';
  import ArrowsDownUp from 'phosphor-svelte/lib/ArrowsDownUp';
  import MagicWand from 'phosphor-svelte/lib/MagicWand';
  import Icon from '../Icon.svelte';
  import TransposeCard from './TransposeCard.svelte';
  import { MAX_TRANSPOSE } from '../../state/pattern-actions';
  import { SCALES, SCALE_IDS } from '../../music/scales';
  import type { MusicKey, ScaleId } from '../../music/scales';
  import { pitchClassName } from '../noteName';
  import { selectKey } from '../selectKey';
  import { tick } from 'svelte';

  let { value, onpick, snap, onsnap, target, selCount, hasNotes, ontranspose, outOfKey, onfit }: {
    value: MusicKey;
    onpick: (key: MusicKey) => void;
    /** Snap to key is on. */
    snap: boolean;
    onsnap: (on: boolean) => void;
    /** What Transpose and Fit act on: "every note", "the 2 selected notes"… */
    target: string;
    /** Selected notes (0: Transpose and Fit act on every note); the Fit label shows it, as Quantize's. */
    selCount: number;
    /** The pattern has notes (Transpose… is disabled otherwise). */
    hasNotes: boolean;
    ontranspose: (semitones: number) => void;
    /** How many of the notes Fit acts on are out of key (0: disabled). */
    outOfKey: number;
    onfit: () => void;
  } = $props();

  let transposing = $state(false);
  let fitBtn = $state<HTMLButtonElement | null>(null);
  /** Fit, then keep the focus in the card: the button it was on is disabled once everything is in key. */
  async function fit() {
    onfit();
    await tick();
    if (fitBtn?.disabled) fitBtn.closest<HTMLElement>('[role="dialog"]')?.focus();
  }
  let transposeBtn = $state<HTMLButtonElement | null>(null);
  const keyName = $derived(`${pitchClassName(value.root)} ${SCALES[value.scale].short}`);
</script>

<p class="lbl">Key</p>
<div class="row">
  <label>Root
    <select data-testid="pr-key-root" value={value.root} onkeydown={selectKey}
      onchange={(e) => onpick({ root: Number(e.currentTarget.value), scale: value.scale })}>
      {#each Array.from({ length: 12 }, (_, i) => i) as pc (pc)}<option value={pc}>{pitchClassName(pc)}</option>{/each}
    </select>
  </label>
  <label>Scale
    <select data-testid="pr-key-scale" value={value.scale} onkeydown={selectKey}
      onchange={(e) => onpick({ root: value.root, scale: e.currentTarget.value as ScaleId })}>
      {#each SCALE_IDS as id (id)}<option value={id}>{SCALES[id].name}</option>{/each}
    </select>
  </label>
</div>
<p class="hint">Out-of-key rows are dimmed and root rows tinted (not in Chromatic).</p>

<div class="tools">
  <button data-testid="pr-snap-key" aria-pressed={snap} class:on={snap}
    title="Snap to key: drawn and moved notes land on the key's notes ({snap ? 'on' : 'off'})"
    onclick={() => onsnap(!snap)}>
    <Icon icon={Magnet} /> Snap to key
  </button>
  <button data-testid="pr-transpose" bind:this={transposeBtn} aria-expanded={transposing} disabled={!hasNotes}
    title="Transpose: move {target} by up to ±{MAX_TRANSPOSE} semitones" onclick={() => (transposing = !transposing)}>
    <Icon icon={ArrowsDownUp} /> Transpose…
  </button>
  <button data-testid="pr-fit-key" bind:this={fitBtn} disabled={!outOfKey} aria-label="Fit to key: {selCount ? `${selCount} selected` : 'all'}"
    title={outOfKey ? `Fit to key: move the ${outOfKey} out-of-key note${outOfKey === 1 ? '' : 's'} of ${target} to the nearest note of ${keyName}` : `Every note of ${target} is in ${keyName}`}
    onclick={fit}>
    <Icon icon={MagicWand} /> Fit {selCount ? `${selCount} sel.` : 'all'}
  </button>
</div>
{#if transposing}
  <div class="sub" role="group" aria-label="Transpose" data-testid="transpose-pop">
    <TransposeCard hint="Moves {target} up or down, keeping the chord shapes (stops at the top and bottom of the keyboard)."
      onapply={ontranspose} close={() => { transposing = false; transposeBtn?.focus(); }} />
  </div>
{/if}

<style>
  /* Tokens only (theme.css .lbl and the select skin; the buttons are the
     roll toolbar's raised recipe). */
  .lbl { margin: 0; }
  .row { display: flex; gap: 10px; }
  .row label { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--fs-ctl); }
  .hint { margin: 0; max-width: 260px; color: var(--text-2); font-size: var(--fs-lbl); }
  .tools { display: flex; gap: 6px; flex-wrap: wrap; }
  .tools button {
    display: inline-flex; align-items: center; gap: 4px;
    font: 500 var(--fs-ctl)/16px var(--font-ui); padding: 2px 10px; border: 0; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); cursor: pointer;
  }
  .tools button:hover:not(:disabled) { filter: brightness(1.08); }
  .tools button:disabled { opacity: 0.45; cursor: not-allowed; }
  .tools button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tools button.on { background: var(--accent) var(--gloss); color: var(--on-color); }
  .sub { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
</style>
