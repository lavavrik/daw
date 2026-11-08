<script lang="ts">
  // A choice param (filter mode, wave, …) as a segmented control (spec §3:
  // choice params with 6 or fewer choices; more stay a skinned <select>).
  // ChoiceParam.svelte picks this or the <select> by the choice count.
  //
  // - The label sits above a `.seg` row (theme.css) of buttons; the picked
  //   one is in the owner's colour (`color`, the module's category colour)
  //   with the gloss and a glow, as on the design canvas.
  // - A `role="radiogroup"` with roving focus: Tab reaches the picked option,
  //   Left/Right (and Up/Down) move the selection and the focus, wrapping;
  //   Home/End pick the first/last. Space is the global play/stop key, so it
  //   does not pick; a click or Enter (a button's click) does. A click also
  //   focuses its option (Chrome does that for buttons, Safari does not), so
  //   the arrow keys go on from where the mouse left off.
  // - Test ids: the group carries the control's `testid` (what the replaced
  //   control had, e.g. `knob-4-mode`), and each option `<testid>-<index>`.
  // - Undo: every change is one `onchange`, so one entry: a click lands
  //   inside its pointer gesture, a key press is an edit of its own.
  // - No automation lane or MIDI learn: choice params have neither.
  // - `look="led"` (plan 21 Task 10; spec §11, the board "Rack, mechanical
  //   faceplates"; the rack and the mixer strips): each option is a raised
  //   push-button (.mech-btn, theme.css) with an LED dot above it (.led); the
  //   picked one is pressed in and its LED glows in `color`. The row wraps
  //   and is centred, with the engraved label under it, as on the board. The
  //   radiogroup, the radios and their test ids, the keys and the undo are
  //   the same as the seg row's; the LED is decoration (aria-hidden).
  import type { KnobDef } from './knobMath';

  let { def, value, onchange, moduleName = '', color, testid, note = '', look = 'seg' }: {
    /** The param: its label and choices (value = the choice's index). */
    def: Pick<KnobDef, 'label' | 'choices'>;
    value: number;
    onchange: (i: number) => void;
    /** For the accessible name: "<module name> <label>". */
    moduleName?: string;
    /** The picked option's colour (the module's category colour). */
    color: string;
    testid?: string;
    /** Extra line under the row, e.g. the Delay's "(max 2 s)"; "" = none. */
    note?: string;
    /** A flat seg row, or LED push-buttons (header comment). */
    look?: 'seg' | 'led';
  } = $props();
  const led = $derived(look === 'led');

  const name = $derived(`${moduleName} ${def.label}`.trim());
  const picked = $derived(Math.round(value));
  let group = $state<HTMLElement | null>(null);

  function key(e: KeyboardEvent) {
    const n = def.choices.length;
    let i: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = (picked + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = (picked - 1 + n) % n;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    if (i === null) return;
    e.preventDefault(); // don't scroll the panel
    if (i !== picked) onchange(i);
    const to = i;
    queueMicrotask(() => group?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus());
  }
</script>

{#snippet option(c: string, i: number)}
  <button
    type="button"
    class:mech-btn={led}
    role="radio"
    aria-checked={i === picked}
    tabindex={i === picked ? 0 : -1}
    data-testid={testid ? `${testid}-${i}` : undefined}
    onclick={(e) => {
      e.currentTarget.focus();
      if (i !== picked) onchange(i);
    }}
  >{c}</button>
{/snippet}

<div class="choice" class:mech={led}>
  {#if !led}<span class="label">{def.label}</span>{/if}
  <div
    class={led ? 'leds' : 'seg'}
    role="radiogroup"
    tabindex="-1"
    aria-label={name}
    data-testid={testid}
    bind:this={group}
    onkeydown={key}
    style:--c={color}
  >
    {#each def.choices as c, i (i)}
      {#if led}
        <span class="opt"><span class="led" class:lit={i === picked} aria-hidden="true"></span>{@render option(c, i)}</span>
      {:else}
        {@render option(c, i)}
      {/if}
    {/each}
  </div>
  {#if led}<span class="engr">{def.label}</span>{/if}
  {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
</div>

<style>
  /* Full width in the module's param grid. */
  .choice { display: flex; flex-direction: column; gap: 4px; grid-column: 1 / -1; padding: 2px 0; }
  .label { padding: 0 2px; font: 500 var(--fs-lbl)/14px var(--font-ui); color: var(--text-2); }
  .seg { flex-wrap: wrap; outline: none; }
  .seg > button { padding: 3px 7px; font: 600 var(--fs-lbl)/14px var(--font-ui); }
  .seg > button[aria-checked='true'] {
    background: var(--c) var(--gloss);
    color: var(--on-color);
    box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--c) 40%, transparent);
  }
  .note { padding: 0 2px; font-size: var(--fs-lbl); color: var(--accent); }
  /* LED look: a centred, wrapping row of LED-over-button columns. */
  .choice.mech { align-items: center; gap: 6px; }
  .leds { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 5px; outline: none; }
  .opt { display: flex; flex-direction: column; align-items: center; gap: 3px; }
</style>
