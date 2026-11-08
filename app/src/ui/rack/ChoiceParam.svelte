<script lang="ts">
  // A choice param (value = the choice's index), drawn by its size (spec §3):
  // SEG_MAX_CHOICES (6) or fewer as a ChoiceSeg row, more as a skinned
  // <select> (theme.css), e.g. the Delay's 12 divisions.
  //
  // Both keep the control's `testid`: ChoiceSeg puts it on its radiogroup
  // (options `<testid>-<i>`), the select carries it itself (so e2e can
  // `selectOption` on it). Every change is one `onchange`, so one undo entry.
  //
  // The select: letters would type-ahead through the options, but they are
  // the QWERTY piano here, so they are swallowed (ui/selectKey.ts). After a
  // pick with the pointer it gives the keys back (blur), like the rack's
  // other selects; a pick from the keyboard (arrows, Enter) keeps focus, so a
  // keyboard user can go on stepping through the options or Tab onwards.
  //
  // `look="led"` (plan 21 Task 10: the rack and the mixer strips): the row is
  // ChoiceSeg's LED push-buttons, and the select's label is engraved.
  import ChoiceSeg from './ChoiceSeg.svelte';
  import { releaseSelect, selectKey } from '../selectKey';
  import { SEG_MAX_CHOICES } from './knobMath';
  import type { KnobDef } from './knobMath';

  let { def, value, onchange, moduleName = '', color, testid, note = '', look = 'seg' }: {
    def: Pick<KnobDef, 'label' | 'choices'>;
    value: number;
    onchange: (i: number) => void;
    /** For the accessible name: "<module name> <label>". */
    moduleName?: string;
    /** The owner's colour (the module's category colour): the picked seg option. */
    color: string;
    testid?: string;
    /** Extra line under the control, e.g. the Delay's "(max 2 s)"; "" = none. */
    note?: string;
    /** A flat seg row, or the mechanical faceplates' LED push-buttons. */
    look?: 'seg' | 'led';
  } = $props();

  const name = $derived(`${moduleName} ${def.label}`.trim());
  const picked = $derived(Math.round(value));

  /** Was the last input on the select a pointer press (a pick from the open picker), not a key? */
  let byPointer = false;
  function pick(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    if (byPointer) releaseSelect(sel);
    const i = Number(sel.value);
    if (i !== picked) onchange(i);
  }
  function onkey(e: KeyboardEvent) {
    byPointer = false;
    selectKey(e);
  }
</script>

{#if def.choices.length <= SEG_MAX_CHOICES}
  <ChoiceSeg {def} {value} {onchange} {moduleName} {color} {testid} {note} {look} />
{:else}
  <div class="choice" class:mech={look === 'led'}>
    <span class={look === 'led' ? 'engr' : 'label'}>{def.label}</span>
    <select data-testid={testid} aria-label={name} value={String(picked)} onchange={pick} onkeydown={onkey} onpointerdown={() => (byPointer = true)}>
      {#each def.choices as c, i (i)}
        <option value={String(i)}>{c}</option>
      {/each}
    </select>
    {#if note}<span class="note" data-testid="knob-note">{note}</span>{/if}
  </div>
{/if}

<style>
  /* Full width in the module's param grid, like ChoiceSeg. */
  .choice { display: flex; flex-direction: column; gap: 4px; grid-column: 1 / -1; padding: 2px 0; }
  .label { padding: 0 2px; font: 500 var(--fs-lbl)/14px var(--font-ui); color: var(--text-2); }
  select { align-self: stretch; }
  .choice.mech { align-items: center; }
  .choice.mech select { align-self: center; }
  .note { padding: 0 2px; font-size: var(--fs-lbl); color: var(--accent); }
</style>
