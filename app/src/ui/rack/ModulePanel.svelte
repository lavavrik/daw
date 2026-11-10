<script lang="ts">
  // One module in the rack, as a mechanical faceplate (plan 21 Task 10;
  // spec §11, the board "Rack, mechanical faceplates"): the gradient panel
  // (.mech-panel) with four corner screws, a header strip in its category
  // colour (ui/theme.ts moduleColor: source, filter, modulation, utility,
  // effect, output; uppercase, letter-spaced, .mech-head) holding the
  // module's name and a × to remove it; then its params; then, under an
  // engraved divider, the input jacks (left) and the output jacks (right).
  //
  // Params: controlMap.ts decides each one's control (its header has the
  // rule), in this order:
  // - choice params: LED push-buttons up to 6 choices (ChoiceParam
  //   look="led"), a skinned <select> past that; full width, centred;
  // - vertical faders (envelope stages, levels) side by side in one row;
  // - mech knobs in a grid (the hero, 'lg', first; 'sm' beside faders or in
  //   a crowded module; 'md' otherwise).
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
  // Note modules (plan 26: Chord, Arp; catalog category "notes"): no jacks,
  // so no port rail; the header says where their notes go ("→ MIDI In": the
  // engine runs them on the note stream before voice allocation, in the
  // fixed order Chord → Arp → MIDI In; docs/architecture/modular.md).
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
  import { releaseSelect, selectKey } from '../selectKey';
  import ChoiceParam from './ChoiceParam.svelte';
  import Jack from './Jack.svelte';
  import Knob from './Knob.svelte';
  import ScopeView from './ScopeView.svelte';
  import SampleStrip from './SampleStrip.svelte';
  import type { Marker } from './sampleStrip';
  import { noteName } from './sampleStrip';
  import ShapePreview from './ShapePreview.svelte';
  import X from 'phosphor-svelte/lib/X';
  import Icon from '../Icon.svelte';
  import { panelControls } from './controlMap';

  let {
    module, def, owner = null, title, isConnected, isPicked = () => false, onparam, onparams, onremove, onjackdown, onjackkey, onjackfocus, tempo = 120, samples = null, onsampledrop, onsamplesopen, scope = null,
    sampleMeta = null, sampleRate = 48000, lastNote = null, place = null, shift = null, raised = false, onheaderdown, onheaderkey,
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
    /** Hovered / focus inside: drawn above the cables not plugged into it (Rack.svelte `lift`). */
    raised?: boolean;
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
    releaseSelect(sel); // give the keys back to the piano at once
    onparam(sampleIdx, Number(sel.value));
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

  const color = $derived(moduleColor(def));
  /** Chord / Arp: on the note stream, no jacks. */
  const noteModule = $derived(def.category === 'notes');
  /** Choices, faders and knobs (controlMap.ts), without the Sample Player's `sample` (its dropdown). */
  const controls = $derived(panelControls(def, sampleIdx));
  /** Continuous knobs follow their automation lanes (not a Scope's: its params only change the view). */
  const autoFor = (name: string) => (owner && !scope ? { owner, target: { kind: 'rack' as const, module: module.idx, param: name } } : null);
</script>

<div
  class="panel mech-panel" class:dropping class:placed={!!place} class:lifted={!!shift} class:raised data-testid={`module-${module.idx}`} role="group" aria-label={title} style:--c={color}
  style:left={place ? `${place.left}px` : undefined} style:top={place ? `${place.top}px` : undefined}
  style:min-height={place?.height ? `${place.height}px` : undefined}
  style:transform={shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined}
  ondragenter={over} ondragover={over} ondragleave={() => (dropping = false)} ondrop={drop}
>
  <!-- The corner screws (decoration): under the header strip and in the bottom corners. -->
  <span class="screw" style:left="6px" style:top="36px"></span><span class="screw" style:right="6px" style:top="36px"></span>
  <span class="screw" style:left="6px" style:bottom="6px"></span><span class="screw" style:right="6px" style:bottom="6px"></span>
  <!-- The drag handle (plan 18): pointer drag, or Alt+arrows when focused. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <header
    class="mech-head"
    data-testid={`module-header-${module.idx}`} tabindex="0" role="group" aria-roledescription="draggable module"
    aria-label={`${title}: drag to move, or Alt+arrow keys`} onpointerdown={headerDown} onkeydown={onheaderkey}
  >
    <span class="title">{title}</span>
    {#if noteModule}<span class="route" data-testid={`module-route-${module.idx}`} title="Plays into MIDI In, before its voices">→ MIDI In</span>{/if}
    <button class="x" aria-label={`Remove ${title}`} title={`Remove ${title}`} onclick={onremove}><Icon icon={X} size={12} /></button>
  </header>
  <!-- No negative margins anywhere in the card: Chrome counts them differently
       for a flow (flex item) and a positioned (absolute) panel, and the two
       widths must agree (rackLayout places by the measured width). -->
  <div class="body">
    {#if samples && sampleIdx >= 0}
      <label class="smp" title="Drop a sample here (library or Finder), or pick one the project has">
        <span class="engr">Sample</span>
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
    {#each controls.choices as { pd, i } (pd.name)}
      <ChoiceParam look="led" def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
        note={noteFor(pd.name, module.params[i])} />
    {/each}
    {#if controls.faders.length}
      <div class="faders">
        {#each controls.faders as { pd, i } (pd.name)}
          <Knob variant="vfader" def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
            auto={autoFor(pd.name)} />
        {/each}
      </div>
    {/if}
    {#if controls.knobs.length}
      <div class="knobs" style:--cols={controls.cols}>
        {#each controls.knobs as { pd, i, size } (pd.name)}
          <Knob variant="mech" {size} def={pd} value={module.params[i]} onchange={(v) => onparam(i, v)} moduleName={title} {color} testid={`knob-${module.idx}-${pd.name}`}
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
  <!-- Under the engraved divider: inputs left, outputs right; side by side when they fit, keeps the rail short. -->
  {#if def.inputs.length || def.outputs.length}
  <div class="ports">
    {#if def.inputs.length}
      <div class="group ins" role="group" aria-label={`${title} inputs`}>
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
      <div class="group outs" role="group" aria-label={`${title} outputs`}>
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
  {/if}
</div>

<style>
  /* The faceplate (spec §11; .mech-panel / .mech-head / .screw in theme.css):
     the gradient panel, 8 px corners, a 30 px header strip in the category
     colour (--c), the screws below it and in the bottom corners. Tokens only. */
  /* Width on the rack's 10 px grid (plan 22 final fix wave, the owner's "uneven
     spacing"): the panel's natural (max-content) width rounded UP to a whole
     10 px, border-box, in flow and positioned alike. Nothing in a panel depends
     on its values (Task 2's fixed chips), so this is fixed per module kind and
     title; rackLayout.ts then keeps exactly 10 px between panels in the flow
     (and at least that when positioned), so every gap is a multiple of 10.
     min-width is a multiple of 10 too. Chrome-only app: calc-size() is fine. */
  .panel {
    flex: none; display: flex; flex-direction: column; box-sizing: border-box;
    width: calc-size(max-content, round(up, size, 10px)); min-width: 180px; color: var(--text);
  }
  /* A sample dragged over a sampler: a dashed border over the faceplate (header included). */
  .panel.dropping::after { content: ''; position: absolute; inset: 0; z-index: 3; border: 2px dashed var(--c); border-radius: inherit; pointer-events: none; }
  .screw { z-index: 1; }
  header { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 18px; border-radius: var(--r-md) var(--r-md) 0 0; cursor: grab; touch-action: none; user-select: none; }
  header:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--mech-head-shadow); }
  /* Positioned rack: the same rounded max-content width as in flow (above), not shrink-to-fit (far right, the
     containing block's leftover width would squeeze the panel). border-box: the row's min-height is a measured offsetHeight. */
  .panel.placed { position: absolute; }
  /* Hovered / focus inside (Rack's `lift`): over the cable layer (z 4), under its own cables (z 7). */
  .panel.raised { z-index: 5; }
  .panel.lifted { z-index: 3; box-shadow: var(--mech-panel-shadow), var(--lift); opacity: 0.92; }
  .panel.lifted header { cursor: grabbing; }
  .title { flex: 1; white-space: nowrap; }
  .route { white-space: nowrap; font-size: var(--fs-lbl); letter-spacing: 0.02em; text-transform: none; opacity: 0.85; }
  .x { display: inline-flex; align-items: center; padding: 2px 4px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--on-color); font: 16px/1 var(--font-ui); cursor: pointer; opacity: 0.55; }
  .panel:hover .x, .x:focus-visible { opacity: 0.85; }
  .x:hover { opacity: 1; }
  .x:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--on-color); }
  /* Clear of the screws: 16 px each side (the screws sit 6 px in, 7 px wide). */
  .body { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 10px; }
  .smp { display: flex; flex-direction: column; gap: 4px; }
  .smp select { max-width: 200px; }
  .root-last { align-self: center; padding: 4px 10px; font-size: var(--fs-lbl); }
  /* Faders side by side; knobs in --cols columns (controlMap knobColumns), each cell its knob's width. */
  .faders { display: flex; justify-content: center; gap: 6px; }
  .knobs { display: grid; grid-template-columns: repeat(var(--cols), auto); justify-content: center; justify-items: center; align-items: start; gap: 12px 10px; }
  /* The spacer (data-stretch, a direct child) is the only part that grows: Rack measures the natural height without it. */
  .spacer { flex: 1; }
  /* The footer: an engraved divider (--mech-divider), inputs left, outputs right; they wrap when the card is narrow. */
  .ports { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 6px 10px; padding: 8px 16px 14px; box-shadow: var(--mech-divider); }
  .group { display: flex; align-items: center; }
  .outs { margin-left: auto; }
  .jacks { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; }
</style>
