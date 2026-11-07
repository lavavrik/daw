<script lang="ts">
  // One module in the rack: a header in its category colour (source orange,
  // shaping purple, utility grey-blue, effect pink) with the module's name and
  // a × to remove it; then its params (choice params as segmented controls,
  // the rest as knobs), then the input jacks, then the output jacks on a dark
  // plate (VCV convention: outputs are the boxed ones).
  //
  // Sample Player: its `sample` param (a sample-pool id, -1 = none) is a
  // dropdown of the project's loaded samples instead of a knob, and the
  // whole panel accepts a sample dropped on it (Finder file or library
  // sample; Rack.svelte imports it and assigns it).
  //
  // Scope (plan 12): its screen (ScopeView.svelte) sits above the knobs;
  // Rack passes `scope` = the track's engine slot (with the module idx it
  // finds its scope-bank slot) and the sample rate.
  //
  // Knobs follow their automation lanes (`owner` = the track: Knob.svelte
  // registers module idx + param name with the app's autoBus) and offer
  // "Automate" on right-click when the param is continuous.
  import type { ModuleDef } from '../../audio/catalog';
  import { isSampleDrag } from '../../library/drag';
  import type { RackModule } from '../../state/project.svelte';
  import { delayClampNote } from '../mixer/mixMath';
  import { categoryColor } from './cables';
  import Jack from './Jack.svelte';
  import Knob from './Knob.svelte';
  import ScopeView from './ScopeView.svelte';

  let {
    module, def, owner = null, title, isConnected, isPicked = () => false, onparam, onremove, onjackdown, onjackkey, onjackfocus, tempo = 120, samples = null, onsampledrop, onsamplesopen, scope = null,
  }: {
    module: RackModule;
    def: ModuleDef;
    /** The synth track's id: its continuous knobs follow their automation lanes (ui/autoBus.ts). */
    owner?: string | null;
    /** Display name, numbered when the rack has several of a kind ("Oscillator 2"). */
    title: string;
    isConnected: (inputPort: number) => boolean;
    onparam: (paramIdx: number, v: number) => void;
    onremove: () => void;
    onjackdown: (e: PointerEvent, dir: 'in' | 'out', port: number) => void;
    /** Keyboard patching (see Jack.svelte); `isPicked`: the jack a cable was picked up from. */
    isPicked?: (dir: 'in' | 'out', port: number) => boolean;
    onjackkey?: (e: KeyboardEvent, dir: 'in' | 'out', port: number) => void;
    onjackfocus?: (dir: 'in' | 'out', port: number) => void;
    /** Transport BPM, for the Delay's "(max 2 s)" note. */
    tempo?: number;
    /** Sample Player only: the project's samples for the `sample` dropdown. */
    samples?: { id: number; name: string }[] | null;
    /** Sample Player only: a sample was dropped on the panel (default already prevented). */
    onsampledrop?: (e: DragEvent) => void;
    /** Sample Player only: the dropdown is about to open (refresh `samples`). */
    onsamplesopen?: () => void;
    /** Scope only: the track's engine slot and the sample rate (its screen). */
    scope?: { track: number; sampleRate: number } | null;
  } = $props();

  /** The `sample` param, shown as a dropdown (Sample Player). */
  const sampleIdx = $derived(samples ? def.params.findIndex((pd) => pd.name === 'sample') : -1);
  const sampleValue = $derived(sampleIdx >= 0 ? module.params[sampleIdx] : -1);
  let dropping = $state(false);
  function over(e: DragEvent) {
    if (!onsampledrop || !isSampleDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropping = true;
  }
  function drop(e: DragEvent) {
    if (!onsampledrop || !isSampleDrag(e)) return;
    e.preventDefault();
    dropping = false;
    onsampledrop(e);
  }
  function pickSample(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    sel.blur(); // give the keys back to the piano at once
    onparam(sampleIdx, Number(sel.value));
  }
  /** A focused <select> type-aheads on letters: the piano keys must not change the sample. */
  function selectKey(e: KeyboardEvent) {
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
  }

  /** Extra line under a control: the Delay division clamped to 2 s (shared
   * with the mixer delay: same table, same rule). */
  const noteFor = (name: string, v: number) => (def.id === 'delay' && name === 'division' ? delayClampNote(v, tempo) : '');

  const color = $derived(categoryColor(def.category));
  const shown = $derived(def.params.map((pd, i) => ({ pd, i })).filter((x) => x.i !== sampleIdx));
  const choices = $derived(shown.filter((x) => x.pd.choices.length));
  const knobs = $derived(shown.filter((x) => !x.pd.choices.length));
  // 1 knob: 1 column; up to 4: 2 columns; more: 4 (keeps the rail short).
  const cols = $derived(knobs.length <= 1 ? 1 : knobs.length <= 4 ? 2 : 4);
</script>

<div
  class="panel" class:dropping data-testid={`module-${module.idx}`} role="group" aria-label={title} style:--c={color}
  ondragenter={over} ondragover={over} ondragleave={() => (dropping = false)} ondrop={drop}
>
  <header>
    <span class="title">{title}</span>
    <button class="x" aria-label={`Remove ${title}`} title={`Remove ${title}`} onclick={onremove}>×</button>
  </header>
  {#if samples && sampleIdx >= 0}
    <label class="smp" title="Drop a sample here (library or Finder), or pick one the project has">
      <span>Sample</span>
      <select
        data-testid={`sample-${module.idx}`} value={sampleValue} onchange={pickSample} onkeydown={selectKey}
        onfocus={onsamplesopen} onpointerdown={onsamplesopen}
      >
        <option value={-1}>— none —</option>
        {#if sampleValue >= 0 && !samples.some((s) => s.id === sampleValue)}
          <option value={sampleValue} disabled>#{sampleValue} (missing)</option>
        {/if}
        {#each samples as s (s.id)}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if scope}
    <ScopeView track={scope.track} idx={module.idx} params={module.params} sampleRate={scope.sampleRate} {tempo} />
  {/if}
  {#if def.params.length}
    <div class="params" style:grid-template-columns={`repeat(${cols}, auto)`}>
      {#each choices as { pd, i } (pd.name)}
        <Knob def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
          note={noteFor(pd.name, module.params[i])} />
      {/each}
      {#each knobs as { pd, i } (pd.name)}
        <Knob def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
          auto={owner ? { owner, target: { kind: 'rack', module: module.idx, param: pd.name } } : null} />
      {/each}
    </div>
  {/if}
  <div class="spacer"></div>
  <!-- inputs, then outputs (boxed); side by side when they fit, keeps the rail short -->
  <div class="ports">
    {#if def.inputs.length}
      <div class="group ins">
        <span class="dir">in</span>
        <div class="jacks">
          {#each def.inputs as port, pi (port.name)}
            <Jack m={module.idx} port={pi} dir="in" name={port.name} signal={port.signal} moduleName={title}
              connected={isConnected(pi)} picked={isPicked('in', pi)} onpointerdown={(e) => onjackdown(e, 'in', pi)}
              onkey={(e) => onjackkey?.(e, 'in', pi)} onfocus={() => onjackfocus?.('in', pi)} />
          {/each}
        </div>
      </div>
    {/if}
    {#if def.outputs.length}
      <div class="group outs">
        <span class="dir">out</span>
        <div class="jacks">
          {#each def.outputs as port, pi (port.name)}
            <Jack m={module.idx} port={pi} dir="out" name={port.name} signal={port.signal} moduleName={title}
              connected={false} picked={isPicked('out', pi)} onpointerdown={(e) => onjackdown(e, 'out', pi)}
              onkey={(e) => onjackkey?.(e, 'out', pi)} onfocus={() => onjackfocus?.('out', pi)} />
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .panel.dropping { outline: 2px dashed var(--c); outline-offset: -2px; }
  .smp { display: flex; flex-direction: column; gap: 2px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: #8d90a0; }
  .smp select { font: inherit; font-size: 11px; text-transform: none; letter-spacing: 0; max-width: 120px; background: #15161a; color: #e6e7ec; border: 1px solid #3a3d48; border-radius: 3px; padding: 1px 2px; }
  .panel { flex: none; display: flex; flex-direction: column; gap: 6px; min-width: 92px; background: #22242b; border: 1px solid #33363f; border-top: 3px solid var(--c); border-radius: 3px; padding: 0 5px 5px; box-shadow: 0 1px 0 #0006; }
  header { display: flex; align-items: center; margin: 0 -5px; padding: 2px 4px 2px 7px; background: color-mix(in srgb, var(--c) 22%, #22242b); }
  .title { flex: 1; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--c); white-space: nowrap; }
  .x { border: 0; background: transparent; color: #8d90a0; font-size: 14px; line-height: 1; padding: 0 2px; cursor: pointer; opacity: 0.6; }
  .panel:hover .x, .x:focus-visible { opacity: 1; }
  .x:hover { color: #ff8a92; }
  .x:focus-visible { outline: 1px solid #f0a23a; }
  .params { display: grid; gap: 4px 2px; justify-content: center; }
  .spacer { flex: 1; }
  .ports { display: flex; flex-wrap: wrap; align-items: stretch; justify-content: space-between; gap: 4px; border-top: 1px solid #2e3038; padding-top: 4px; }
  .group { display: flex; align-items: center; gap: 2px; flex: 1 1 auto; padding: 2px; }
  .outs { background: #15161a; border: 1px solid #2e3038; border-radius: 3px; }
  .dir { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: #6f7280; }
  .jacks { display: flex; flex-wrap: wrap; gap: 2px; flex: 1; justify-content: center; }
</style>
