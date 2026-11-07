<script lang="ts">
  // A labelled patch point, ringed in its signal colour (SIGNAL_COLORS).
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
  import { SIGNAL_COLORS } from './cables';

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
  style:--c={SIGNAL_COLORS[signal]}
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
  .jack { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 28px; padding: 2px 1px; cursor: grab; touch-action: none; user-select: none; }
  .hole { width: 12px; height: 12px; border-radius: 50%; background: #0b0b0d; border: 2.5px solid var(--c); box-shadow: inset 0 0 0 2px #2a2c33; }
  .jack:hover .hole { box-shadow: 0 0 0 2px #ffffff55, inset 0 0 0 2px #2a2c33; }
  .name { font-size: 10px; color: #c9cbd3; white-space: nowrap; }
  .jack:focus-visible { outline: 2px solid #f0a23a; outline-offset: 1px; border-radius: 4px; }
  .picked .hole { background: var(--c); box-shadow: 0 0 0 3px #f0a23a; }
</style>
