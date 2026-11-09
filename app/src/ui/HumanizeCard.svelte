<script module lang="ts">
  /**
   * The last amount applied (1..100 %), for the whole session: both editors
   * share it. Starts at 50 %, and is never 0 (Apply does nothing at 0).
   */
  let lastAmount = 50;
</script>

<script lang="ts">
  // The Humanize… popover's content (plan 25; docs/architecture/sequencer.md
  // "Humanize"): an amount slider 0-100 % and Apply. Apply calls `onapply`
  // with the amount as 0..1 (humanizeDrum / humanizeNotes: one undo entry)
  // and closes the popover. Moving the slider changes nothing by itself, so
  // a drag is not an edit; Enter on the slider applies too.
  import { rangeFill } from './rangeFill';

  let { hint, onapply, close }: {
    /** What Apply changes, one sentence under the slider. */
    hint: string;
    onapply: (amount: number) => void;
    close: () => void;
  } = $props();

  let amount = $state(lastAmount > 0 ? lastAmount : 50);
  function apply() {
    if (amount <= 0) return; // Enter on the slider at 0: nothing to apply (as the disabled button)
    lastAmount = amount;
    onapply(amount / 100);
    close();
  }
</script>

<p class="lbl">Humanize</p>
<label class="amt">
  <span class="sr-only">Amount</span>
  <input
    type="range" min="0" max="100" step="1" bind:value={amount} data-testid="humanize-amount"
    style:--fill={rangeFill(amount / 100).fill}
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
  />
  <span class="mono pct" data-testid="humanize-pct">{amount}%</span>
</label>
<p class="hint">{hint}</p>
<button class="btn primary" data-testid="humanize-apply" disabled={amount === 0} onclick={apply}>Apply</button>

<style>
  /* Tokens only (theme.css .lbl, .btn.primary, the range skin). */
  .lbl { margin: 0; }
  .amt { display: flex; align-items: center; gap: 8px; }
  .amt input { width: 160px; }
  .pct { width: 36px; text-align: right; color: var(--text); font-size: var(--fs-ctl); }
  .hint { margin: 0; max-width: 220px; color: var(--text-2); font-size: var(--fs-lbl); }
  .btn { align-self: flex-end; padding: 4px 14px; }
</style>
