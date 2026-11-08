<script lang="ts">
  // A labelled patch point: a glossy hole in its signal colour (spec §4:
  // audio orange, cv blue, gate green, vel purple; ui/theme.ts jackColor maps
  // the catalog's signal kinds, pitch is cv). Its cables take the same colour.
  //
  // The Rack owns all cable logic. A Jack only:
  // - carries data attributes (`data-jack`, `data-m`, `data-port`,
  //   `data-dir`) on its outer element. The Rack hit-tests drops with
  //   document.elementFromPoint(...).closest('[data-jack]'), and measures
  //   each jack's centre from its `.hole` element (that is how a Jack
  //   "exposes its centre position": the Rack queries the DOM on patch
  //   change, scroll and resize instead of every jack reporting in);
  // - forwards pointerdown to the Rack, which captures the pointer on this
  //   element for the rest of the drag;
  // - is a focusable button for keyboard patching: Enter/Space picks it up
  //   (or drops the cable already picked up onto it), Delete unplugs a
  //   picked-up cable, Esc cancels -- all decided by the Rack (`onkey`).
  //   `picked` marks the jack the cable was picked up from (aria-pressed).
  // The outer element (label + hole) is the hit area, so a drop on the label
  // counts too. The label sits ABOVE the hole: cables always sag downward
  // from the hole, so they never strike through jack names.
  import type { SignalKind } from '../../audio/catalog';
  import { jackColor } from '../theme';

  let { m, port, dir, name, signal, moduleName, connected, picked = false, onpointerdown, onkey, onfocus }: {
    m: number;
    port: number;
    dir: 'in' | 'out';
    name: string;
    signal: SignalKind;
    moduleName: string;
    connected: boolean;
    picked?: boolean;
    onpointerdown: (e: PointerEvent) => void;
    onkey?: (e: KeyboardEvent) => void;
    onfocus?: () => void;
  } = $props();

  const hint = $derived(
    dir === 'out'
      ? 'drag (or Enter) to an input to patch'
      : connected ? 'drag (or Enter) to move or unplug the cable' : 'drag (or Enter) to an output to patch',
  );
  const label = $derived(`${moduleName} ${name} ${dir === 'in' ? 'input' : 'output'}${connected ? ', connected' : ''}`);
</script>

<div
  class="jack"
  data-jack
  data-m={m}
  data-port={port}
  data-dir={dir}
  data-testid={`jack-${m}-${dir}-${name}`}
  title={`${moduleName} ${name} (${dir === 'in' ? 'input' : 'output'}, ${signal}) — ${hint}`}
  style:--c={jackColor({ name, signal })}
  class:picked
  role="button"
  tabindex="0"
  aria-label={label}
  aria-pressed={picked}
  {onpointerdown}
  onkeydown={onkey}
  {onfocus}
>
  <span class="name">{name}</span>
  <span class="hole" class:connected></span>
</div>

<style>
  /* Tokens only: the hole is the signal colour with the gloss, in a --lcd rim. */
  .jack { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 28px; padding: 2px 1px; border-radius: var(--r-sm); cursor: grab; touch-action: none; user-select: none; }
  .hole { box-sizing: border-box; width: 15px; height: 15px; border: 3px solid var(--lcd); border-radius: 50%; background: var(--c) var(--gloss); box-shadow: var(--handle-shadow); }
  .jack:hover .hole { box-shadow: var(--handle-shadow), 0 0 0 2px color-mix(in srgb, var(--c) 55%, transparent); }
  .name { font: 500 9px var(--font-ui); color: var(--text-2); white-space: nowrap; }
  .jack:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .picked .hole { border-color: var(--text); box-shadow: 0 0 0 3px var(--accent), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
</style>
