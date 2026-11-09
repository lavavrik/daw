<script lang="ts">
  // The Transpose… popover's content (plan 26 Task 1; docs/architecture/
  // theory.md): a semitone slider -12..+12 and Apply. Apply calls `onapply`
  // with the semitones (pattern-actions transposeNotes: the selection or
  // every note, one "Transpose" undo entry) and closes the popover. Moving
  // the slider changes nothing by itself; Enter on it applies too. Same
  // shape as HumanizeCard.
  import { MAX_TRANSPOSE } from '../../state/pattern-actions';
  import { rangeFillBipolar } from '../rangeFill';

  let { hint, onapply, close }: {
    /** What Apply moves, one sentence under the slider. */
    hint: string;
    onapply: (semitones: number) => void;
    close: () => void;
  } = $props();

  let st = $state(0);
  const shown = $derived(st > 0 ? `+${st}` : `${st}`);
  /** Bipolar: the fill runs from the centre (0) to the handle. */
  const fill = $derived(rangeFillBipolar((st + MAX_TRANSPOSE) / (2 * MAX_TRANSPOSE)));
  function apply() {
    if (st === 0) return; // Enter at 0: nothing to apply (as the disabled button)
    onapply(st);
    close();
  }
</script>

<p class="lbl">Transpose</p>
<label class="amt">
  <span class="sr-only">Semitones</span>
  <input
    type="range" min={-MAX_TRANSPOSE} max={MAX_TRANSPOSE} step="1" bind:value={st} data-testid="transpose-amount"
    style:--fill={fill.fill} style:--fill-pos={fill.pos}
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
  />
  <span class="mono val" data-testid="transpose-value">{shown} st</span>
</label>
<p class="hint">{hint}</p>
<button class="btn primary" data-testid="transpose-apply" disabled={st === 0} onclick={apply}>Apply</button>

<style>
  /* Tokens only (theme.css .lbl, .btn.primary, the range skin), as HumanizeCard. */
  .lbl { margin: 0; }
  .amt { display: flex; align-items: center; gap: 8px; }
  .amt input { width: 160px; }
  .val { width: 44px; text-align: right; color: var(--text); font-size: var(--fs-ctl); }
  .hint { margin: 0; max-width: 220px; color: var(--text-2); font-size: var(--fs-lbl); }
  .btn { align-self: flex-end; padding: 4px 14px; }
</style>
