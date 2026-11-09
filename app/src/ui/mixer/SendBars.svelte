<script lang="ts">
  // The closed Sends section's summary on a track strip (plan 29, spec
  // "Mixer layout", option C): one mini level bar per return, in the
  // returns' creation order and each in its return's colour
  // (`--return-<slot>`), filled to the send's fader position (the sends'
  // fader law, mixMath faderPos: the same travel as the knob's arc).
  //
  // The bars only show: they are not draggable. Clicking one opens the
  // section (`onopen`), where the knobs are. They are out of the tab order
  // (`tabindex="-1"`): the section's own header button opens it from the
  // keyboard, and eight extra stops per strip would only slow Tab down.
  import { mixParam } from '../../audio/mixerCatalog';
  import { sendParam } from '../../audio/protocol';
  import { returnColor, type ReturnState } from '../../state/returns';
  import { faderPos, formatDb } from './mixMath';

  let { returns, level, onopen }: {
    returns: ReturnState[];
    /** The track's send level (dB) to return slot `slot`. */
    level: (slot: number) => number;
    onopen: () => void;
  } = $props();

  const min = $derived(mixParam(sendParam(0)).min);
</script>

<span class="bars">
  {#each returns as r (r.id)}
    {@const db = level(r.slot)}
    <button
      type="button"
      class="bar mech-slot"
      tabindex="-1"
      style:--c={returnColor(r.slot)}
      data-testid={`send-bar-${r.slot}`}
      data-db={db.toFixed(1)}
      aria-label={`${r.name} send ${db <= min ? 'off' : formatDb(db)}: show the sends`}
      title={`${r.name} send: ${db <= min ? 'Off' : formatDb(db)} — click to show the sends`}
      onclick={onopen}
    ><i style:width={`${faderPos(db) * 100}%`}></i></button>
  {/each}
</span>

<style>
  .bars { display: flex; gap: 3px; padding: 3px 0 2px; }
  /* A 6 px recessed groove (half-height corners are geometry) with the fill in the return's colour. */
  .bar { position: relative; flex: 1; min-width: 0; height: 6px; padding: 0; border: 0; border-radius: 3px; overflow: hidden; cursor: pointer; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--c); box-shadow: 0 0 4px color-mix(in srgb, var(--c) 60%, transparent); }
  /* A thin rim in the colour, so an Off send still says whose bar it is. */
  .bar::after { content: ''; position: absolute; inset: 0; border-radius: 3px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 45%, transparent); pointer-events: none; }
  .bar:hover { filter: brightness(1.25); }
</style>
