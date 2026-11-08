<script lang="ts">
  // One module in the rack (plan 20 Task 9; spec §4 "Rack", the design
  // board "Instrument rack"): a --lift card with a glossy header in its
  // category colour (ui/theme.ts moduleColor: source, filter, modulation,
  // utility, effect, output) holding the module's name and a × to remove it;
  // then its params; then the input jacks (left) and the output jacks (right,
  // on a recessed plate: VCV's convention, outputs are the boxed ones).
  //
  // Params (spec §3), in this order:
  // - choice params: ChoiceParam (a ChoiceSeg row up to 6 choices, a
  //   <select> past that), full width;
  // - the module's hero param, if it has one (HERO below): a big dial;
  // - every other continuous or integer param: a slider, one column, or two
  //   when the module has more than SLIDER_ONE_COLUMN of them (keeps the
  //   card short: the Formant has ten).
  // Every control keeps the test id `knob-<idx>-<param>`.
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
  // Scope (plan 12): its screen (ScopeView.svelte) sits above the params;
  // Rack passes `scope` = the track's engine slot (with the module idx it
  // finds its scope-bank slot) and the sample rate.
  //
  // ADSR / LFO (plan 12 Task 5): a shape preview (ShapePreview.svelte) above
  // the params, following the values shown (lanes included).
  //
  // Sliders and dials follow their automation lanes (not a Scope's: its params only
  // change the view) (`owner` = the track: Knob.svelte
  // registers module idx + param name with the app's autoBus) and offer
  // "Automate" on right-click when the param is continuous.
  //
  // Free layout (plan 18): the header is the panel's drag handle (focusable;
  // Alt+arrow keys move the panel). Rack.svelte owns the drag: it gets the
  // press through `onheaderdown` (a press on the header's × does not start
  // one) and the keys through `onheaderkey`, and places the panel with
  // `place` (positioned rack: absolute left/top inside `.content`, and the
  // row's height as min-height so a row's jacks line up as in flow; null =
  // flow) and `shift` (the dragged panel's translate while it follows the
  // pointer). The spacer above the ports (`data-stretch`) is the only part
  // that grows: Rack subtracts it to measure the panel's natural height.
  import type { ModuleDef } from '../../audio/catalog';
  import { isSampleDrag } from '../../library/drag';
  import type { RackModule, SampleMeta } from '../../state/project.svelte';
  import { delayClampNote } from '../mixer/mixMath';
  import { moduleColor } from '../theme';
  import ChoiceParam from './ChoiceParam.svelte';
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
    /** Positioned rack: the panel's left/top in `.content` px and its row's height (min-height); null = flow (flex-wrap). */
    place?: { left: number; top: number; height: number } | null;
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

  /** The one param per module kind that stays a dial (spec §3 "Where each is used"). */
  const HERO: Record<string, string> = { filter: 'cutoff', sample_player: 'root', lfo: 'rate' };
  /** Up to this many sliders stack in one column; more go two per row. */
  const SLIDER_ONE_COLUMN = 5;
  const color = $derived(moduleColor(def));
  const shown = $derived(def.params.map((pd, i) => ({ pd, i })).filter((x) => x.i !== sampleIdx));
  const choices = $derived(shown.filter((x) => x.pd.choices.length));
  const hero = $derived(shown.find((x) => !x.pd.choices.length && HERO[def.id] === x.pd.name) ?? null);
  const sliders = $derived(shown.filter((x) => !x.pd.choices.length && x !== hero));
  const twoCols = $derived(sliders.length > SLIDER_ONE_COLUMN);
  /** Continuous knobs follow their automation lanes (not a Scope's: its params only change the view). */
  const autoFor = (name: string) => (owner && !scope ? { owner, target: { kind: 'rack' as const, module: module.idx, param: name } } : null);
</script>

<div
  class="panel" class:dropping class:placed={!!place} class:lifted={!!shift} data-testid={`module-${module.idx}`} role="group" aria-label={title} style:--c={color}
  style:left={place ? `${place.left}px` : undefined} style:top={place ? `${place.top}px` : undefined}
  style:min-height={place?.height ? `${place.height}px` : undefined}
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
  <!-- No negative margins anywhere in the card: Chrome counts them differently
       for a flow (flex item) and a positioned (width: max-content) panel, and
       the two widths must agree (rackLayout snaps to the measured width). -->
  <div class="body">
    {#if samples && sampleIdx >= 0}
      <label class="smp" title="Drop a sample here (library or Finder), or pick one the project has">
        <span class="lbl">Sample</span>
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
    {#if shown.length}
      <div class="params" class:two={twoCols}>
        {#each choices as { pd, i } (pd.name)}
          <ChoiceParam def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
            note={noteFor(pd.name, module.params[i])} />
        {/each}
        {#if hero}
          {@const { pd, i } = hero}
          <div class="hero">
            <Knob def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
              auto={autoFor(pd.name)} />
          </div>
        {/if}
        {#each sliders as { pd, i } (pd.name)}
          <Knob variant="slider" def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
            auto={autoFor(pd.name)} />
        {/each}
      </div>
    {/if}
    {#if strip}
      {@const root = strip.at.root}
      <button
        class="btn root-last" data-testid={`root-from-last-${module.idx}`} disabled={lastNote === null}
        title={lastNote === null ? 'Play a note (keyboard or MIDI) first: Root then takes it' : `Set Root to the last played note (${noteName(lastNote)})`}
        onclick={() => { if (lastNote !== null && lastNote !== module.params[root]) onparam(root, lastNote); }}
      >Root ← last note{lastNote !== null ? ` (${noteName(lastNote)})` : ''}</button>
    {/if}
  </div>
  <div class="spacer" data-stretch></div>
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
  /* The card (spec §4 "Rack"): --lift, 12 px corners, a glossy header in the
     category colour (--c) with dark text. Tokens only. */
  .panel { flex: none; display: flex; flex-direction: column; min-width: 180px; border-radius: var(--r-lg); background: var(--panel); box-shadow: var(--lift); color: var(--text); }
  .panel.dropping { outline: 2px dashed var(--c); outline-offset: -2px; }
  header { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 12px; border-radius: var(--r-lg) var(--r-lg) 0 0; background: var(--c) var(--gloss); box-shadow: var(--raised-shadow); color: var(--on-color); cursor: grab; touch-action: none; user-select: none; }
  header:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* Positioned rack: max-content, not shrink-to-fit (far right, the containing block's leftover width would squeeze the panel).
     border-box: the row's min-height is a measured offsetHeight. */
  .panel.placed { position: absolute; width: max-content; box-sizing: border-box; }
  .panel.lifted { z-index: 3; box-shadow: var(--lift), var(--lift); opacity: 0.92; }
  .panel.lifted header { cursor: grabbing; }
  .title { flex: 1; font: 700 var(--fs-ctl) var(--font-ui); white-space: nowrap; }
  .x { padding: 0 4px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--on-color); font: 16px/1 var(--font-ui); cursor: pointer; opacity: 0.55; }
  .panel:hover .x, .x:focus-visible { opacity: 0.85; }
  .x:hover { opacity: 1; }
  .x:focus-visible { outline: 2px solid var(--on-color); }
  .body { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; }
  .smp { display: flex; flex-direction: column; gap: 4px; }
  .smp select { max-width: 200px; }
  .root-last { align-self: center; padding: 4px 10px; font-size: var(--fs-lbl); }
  /* Choices and the hero span the grid; sliders take a cell each (Knob's
     slider spans the row by default: in two columns it takes one). */
  .params { display: grid; grid-template-columns: minmax(150px, 1fr); gap: 8px 14px; }
  .params.two { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
  .params.two > :global(.slider) { grid-column: auto; }
  .hero { grid-column: 1 / -1; display: flex; justify-content: center; --dial: 60px; }
  /* The spacer (data-stretch, a direct child) is the only part that grows: Rack measures the natural height without it. */
  .spacer { flex: 1; }
  /* Inputs left, outputs right on a recessed plate; they wrap when the card is narrow. */
  .ports { display: flex; flex-wrap: wrap; align-items: stretch; justify-content: space-between; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--line); }
  .group { display: flex; align-items: center; gap: 2px; padding: 2px 4px; }
  .outs { margin-left: auto; border-radius: var(--r-md); background: var(--work); box-shadow: var(--well-shadow); }
  .dir { writing-mode: vertical-rl; transform: rotate(180deg); font: 600 9px var(--font-ui); letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2); }
  .jacks { display: flex; flex-wrap: wrap; gap: 2px; justify-content: center; }
</style>
