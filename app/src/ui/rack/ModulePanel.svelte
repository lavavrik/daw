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
  // Under the dropdown, SampleStrip.svelte (plan 15 Task 5) shows the sample
  // (`sampleMeta`'s peaks) with draggable Start / End / Loop start markers;
  // they edit through `onparam` like the knobs (`onparams` when End pushes
  // Loop start along: one undo entry). Its Root knob reads as a
  // note name (knobMath.formatValue), and "Root ← last note" sets Root to
  // `lastNote` (the last live note, input/lastNote.svelte.ts; disabled until
  // one has arrived since load).
  //
  // Scope (plan 12): its screen (ScopeView.svelte) sits above the knobs;
  // Rack passes `scope` = the track's engine slot (with the module idx it
  // finds its scope-bank slot) and the sample rate.
  //
  // ADSR / LFO (plan 12 Task 5): a shape preview (ShapePreview.svelte) above
  // the knobs, following the knob values shown (lanes included).
  //
  // Knobs follow their automation lanes (not a Scope's: its params only
  // change the view) (`owner` = the track: Knob.svelte
  // registers module idx + param name with the app's autoBus) and offer
  // "Automate" on right-click when the param is continuous.
  //
  // Free layout (plan 18): the header is the panel's drag handle (focusable;
  // Alt+arrow keys move the panel). Rack.svelte owns the drag: it gets the
  // press through `onheaderdown` (a press on the header's × does not start
  // one) and the keys through `onheaderkey`, and places the panel with
  // `place` (positioned rack: absolute left/top inside `.content`; null =
  // flow) and `shift` (the dragged panel's translate while it follows the
  // pointer).
  import type { ModuleDef } from '../../audio/catalog';
  import { isSampleDrag } from '../../library/drag';
  import type { RackModule, SampleMeta } from '../../state/project.svelte';
  import { delayClampNote } from '../mixer/mixMath';
  import { categoryColor } from './cables';
  import Jack from './Jack.svelte';
  import Knob from './Knob.svelte';
  import ScopeView from './ScopeView.svelte';
  import SampleStrip from './SampleStrip.svelte';
  import type { Marker } from './sampleStrip';
  import { noteName } from './sampleStrip';
  import ShapePreview from './ShapePreview.svelte';

  let {
    module, def, owner = null, title, isConnected, isPicked = () => false, onparam, onparams, onremove, onjackdown, onjackkey, onjackfocus, tempo = 120, samples = null, onsampledrop, onsamplesopen, scope = null,
    sampleMeta = null, sampleRate = 48000, lastNote = null, place = null, shift = null, onheaderdown, onheaderkey,
  }: {
    module: RackModule;
    def: ModuleDef;
    /** The synth track's id: its continuous knobs follow their automation lanes (ui/autoBus.ts). */
    owner?: string | null;
    /** Display name, numbered when the rack has several of a kind ("Oscillator 2"). */
    title: string;
    isConnected: (inputPort: number) => boolean;
    onparam: (paramIdx: number, v: number) => void;
    /** Several params as one undo entry (the Sample Player strip's End push); absent: one onparam each. */
    onparams?: (values: [paramIdx: number, v: number][]) => void;
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
    /** Sample Player only: the assigned sample's meta (its strip's peaks), or null. */
    sampleMeta?: SampleMeta | null;
    /** The engine's sample rate (the strip's axis before peaks exist). */
    sampleRate?: number;
    /** Sample Player only: the last live note since load, or null ("Root ← last note"). */
    lastNote?: number | null;
    /** Scope only: the track's engine slot and the sample rate (its screen). */
    scope?: { track: number; sampleRate: number } | null;
    /** Positioned rack: the panel's left/top in `.content` px; null = flow (flex-wrap). */
    place?: { left: number; top: number } | null;
    /** While dragged: the translate (px) that keeps it under the pointer. */
    shift?: { x: number; y: number } | null;
    /** A primary press on the header (not on its × button): Rack starts a module drag. */
    onheaderdown?: (e: PointerEvent) => void;
    /** A key on the focused header (Alt+arrows move the module). */
    onheaderkey?: (e: KeyboardEvent) => void;
  } = $props();

  /** Presses on the header's own controls (×) are theirs, not a drag. */
  function headerDown(e: PointerEvent) {
    if ((e.target as Element).closest('button, select, input, [data-jack]')) return;
    onheaderdown?.(e);
  }

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

  // Sample Player: the strip's markers and the root button.
  const pi = (name: string) => def.params.findIndex((pd) => pd.name === name);
  const strip = $derived.by(() => {
    if (!samples || def.id !== 'sample_player') return null;
    const at = { start: pi('start'), end: pi('end'), loopStart: pi('loopStart'), loop: pi('loop'), root: pi('root') };
    if (at.start < 0 || at.end < 0 || at.loopStart < 0 || at.loop < 0 || at.root < 0) return null;
    const v = (i: number) => module.params[i];
    return { at, region: { start: v(at.start), end: v(at.end), loopStart: v(at.loopStart) }, loop: v(at.loop) >= 0.5 };
  });
  /** The strip's marker changes: one param through onparam, two (End pushing Loop start) as one entry. */
  function markerChange(changes: Partial<Record<Marker, number>>) {
    if (!strip) return;
    const at = strip.at;
    const values = (Object.entries(changes) as [Marker, number][]).map(([m, v]) => [at[m], v] as [number, number]);
    if (values.length === 1) onparam(values[0][0], values[0][1]);
    else if (values.length > 1) {
      if (onparams) onparams(values);
      else for (const [i, v] of values) onparam(i, v);
    }
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
  class="panel" class:dropping class:placed={!!place} class:lifted={!!shift} data-testid={`module-${module.idx}`} role="group" aria-label={title} style:--c={color}
  style:left={place ? `${place.left}px` : undefined} style:top={place ? `${place.top}px` : undefined}
  style:transform={shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined}
  ondragenter={over} ondragover={over} ondragleave={() => (dropping = false)} ondrop={drop}
>
  <!-- The drag handle (plan 18): pointer drag, or Alt+arrows when focused. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <header
    data-testid={`module-header-${module.idx}`} tabindex="0" role="group" aria-roledescription="draggable module"
    aria-label={`${title}: drag to move, or Alt+arrow keys`} onpointerdown={headerDown} onkeydown={onheaderkey}
  >
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
    {#if strip}
      <SampleStrip idx={module.idx} sampleId={sampleValue} meta={sampleMeta} {sampleRate} region={strip.region} loop={strip.loop} {color} onchange={markerChange} />
    {/if}
  {/if}
  {#if scope}
    <ScopeView track={scope.track} idx={module.idx} params={module.params} sampleRate={scope.sampleRate} {tempo} />
  {/if}
  {#if def.id === 'adsr' || def.id === 'lfo'}
    <ShapePreview {def} idx={module.idx} params={module.params} {owner} {tempo} {color} />
  {/if}
  {#if def.params.length}
    <div class="params" style:grid-template-columns={`repeat(${cols}, auto)`}>
      {#each choices as { pd, i } (pd.name)}
        <Knob def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
          note={noteFor(pd.name, module.params[i])} />
      {/each}
      {#each knobs as { pd, i } (pd.name)}
        <Knob def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
          auto={owner && !scope ? { owner, target: { kind: 'rack', module: module.idx, param: pd.name } } : null} />
      {/each}
    </div>
  {/if}
  {#if strip}
    {@const root = strip.at.root}
    <button
      class="root-last" data-testid={`root-from-last-${module.idx}`} disabled={lastNote === null}
      title={lastNote === null ? 'Play a note (keyboard or MIDI) first: Root then takes it' : `Set Root to the last played note (${noteName(lastNote)})`}
      onclick={() => { if (lastNote !== null && lastNote !== module.params[root]) onparam(root, lastNote); }}
    >Root ← last note{lastNote !== null ? ` (${noteName(lastNote)})` : ''}</button>
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
  .root-last { align-self: center; font: inherit; font-size: 10px; background: #15161a; color: #d7d9e0; border: 1px solid #3a3d48; border-radius: 3px; padding: 1px 6px; cursor: pointer; }
  .root-last:hover:not(:disabled) { border-color: var(--c); color: #fff; }
  .root-last:disabled { opacity: 0.45; cursor: default; }
  .root-last:focus-visible { outline: 1px solid #f0a23a; }
  .panel { flex: none; display: flex; flex-direction: column; gap: 6px; min-width: 92px; background: #22242b; border: 1px solid #33363f; border-top: 3px solid var(--c); border-radius: 3px; padding: 0 5px 5px; box-shadow: 0 1px 0 #0006; }
  header { display: flex; align-items: center; margin: 0 -5px; padding: 2px 4px 2px 7px; background: color-mix(in srgb, var(--c) 22%, #22242b); cursor: grab; touch-action: none; user-select: none; }
  header:focus-visible { outline: 1px solid #f0a23a; outline-offset: -1px; }
  /* Positioned rack: max-content, not shrink-to-fit (far right, the containing block's leftover width would squeeze the panel). */
  .panel.placed { position: absolute; width: max-content; }
  .panel.lifted { z-index: 3; box-shadow: 0 8px 24px #000c; opacity: 0.92; }
  .panel.lifted header { cursor: grabbing; }
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
