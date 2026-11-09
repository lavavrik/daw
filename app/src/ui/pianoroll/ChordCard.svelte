<script lang="ts">
  // The chord stamp's options popover (plan 26 Task 2; docs/architecture/
  // theory.md "Chord stamp"): a chord-type select (scales.ts CHORD_TYPES)
  // and an inversion select 0..MAX_INVERSION. Each pick applies at once and
  // turns chord mode on (picking a chord means you want to place it: the
  // roll's `onpick`); nothing here is an edit of the project. Esc or a press
  // outside closes it, like KeyCard.
  import { CHORD_TYPES, MAX_INVERSION } from '../../music/scales';
  import type { ChordType } from '../../music/scales';
  import { selectKey } from '../selectKey';

  let { type, inversion, onpick }: {
    type: ChordType;
    inversion: number;
    onpick: (o: { type: ChordType; inversion: number }) => void;
  } = $props();

  const INVERSIONS = ['Root position', '1st inversion', '2nd inversion', '3rd inversion'].slice(0, MAX_INVERSION + 1);
</script>

<p class="lbl">Chord</p>
<div class="row">
  <label>Type
    <select data-testid="pr-chord-type" value={type} onkeydown={selectKey}
      onchange={(e) => onpick({ type: e.currentTarget.value as ChordType, inversion })}>
      {#each CHORD_TYPES as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
    </select>
  </label>
  <label>Inversion
    <select data-testid="pr-chord-inv" value={inversion} onkeydown={selectKey}
      onchange={(e) => onpick({ type, inversion: Number(e.currentTarget.value) })}>
      {#each INVERSIONS as name, i (i)}<option value={i}>{name}</option>{/each}
    </select>
  </label>
</div>
<p class="hint">Click the grid to place the chord on that row, one grid cell long. In key plays the key's seventh chord there; an inversion moves the lowest notes up an octave. Esc leaves chord mode.</p>

<style>
  /* Tokens only (theme.css .lbl and the select skin), as KeyCard. */
  .lbl { margin: 0; }
  .row { display: flex; gap: 10px; }
  .row label { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--fs-ctl); }
  .hint { margin: 0; max-width: 260px; color: var(--text-2); font-size: var(--fs-lbl); }
</style>
