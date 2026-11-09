<script module lang="ts">
  // A control's menu items (plan 10 Task 4, plan 14 Task 3), the lower half
  // of the precise-value popover (ValuePopover.svelte, plan 24): the card
  // owns the title, the placement, the outside press, Esc and the keys'
  // isolation; this renders only the list. Its items, in order:
  //   - "Automate" (no lane on that target yet: creates it, one undo entry)
  //     or "Show automation". Either way it opens the owner's lanes on the
  //     timeline (the track's A; the Master row for the returns and the
  //     master) and scrolls the lane into view. Only for continuous params
  //     (autoBus.canAutomate).
  //   - "MIDI learn" (ui/midiLearn.svelte.ts startLearn: the next CC binds
  //     to it) or, when the control has a CC, "Forget MIDI (CC 74)" (one
  //     undo entry). For continuous and integer params (canLearn), not
  //     choices or on/off flags.
  // The popover shows the list when either kind of item exists (menuItems).
  // ArrowUp / ArrowDown move between the items. `onclose` closes the host
  // before an item acts. Test ids: `auto-ctl-menu` on the list,
  // `auto-ctl-automate`, `auto-ctl-midi`.
  // (Until plan 24 Task 2 this was also a floating menu of its own,
  // openAutoMenu; every control now opens the popover instead.)
  import type { MixChannelTarget } from '../state/mixer-actions';
  import type { AutoTarget } from '../state/project.svelte';
  import type { AutoBus } from './autoBus';

  /** Which items a control's menu has (the popover lists them when one is true). */
  export function menuItems(bus: AutoBus, owner: MixChannelTarget, target: AutoTarget) {
    return { automate: bus.canAutomate(owner, target), midi: bus.canLearn(owner, target) };
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import type { CommandSink } from '../state/actions';
  import { isMasterChannel } from '../state/automation';
  import { addLane } from '../state/automation-actions';
  import { flashHint } from '../state/banners.svelte';
  import { forgetMidi, mappingFor } from '../state/midiMap';
  import type { Project } from '../state/project.svelte';
  import { startLearn } from './midiLearn.svelte';
  import { laneView, setOpen } from './song/laneView.svelte';
  import { MASTER_ROW } from './song/tlMath';

  /** The control the items act on. */
  type ItemsFor = { owner: MixChannelTarget; target: AutoTarget; label: string };

  let { p, engine, bus, control, onclose }: {
    p: Project;
    engine: CommandSink;
    bus: AutoBus;
    /** The control: its owner, target, and accessible name (the learn hint's). */
    control: ItemsFor;
    /** Close the host (it returns the focus) before an item acts. */
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement | null>(null);
  const exists = $derived(bus.laneFor(control.owner, control.target) !== null);
  const items = $derived(menuItems(bus, control.owner, control.target));
  /** The control's CC mapping ("Forget MIDI (CC 74)"), or null ("MIDI learn"). */
  const mapped = $derived(mappingFor(p, control.owner, control.target));
  const close = () => onclose();

  // Each item reads what it needs before close(): closing the host unmounts
  // this component, and its props are not read after that.
  async function act() {
    const r = control;
    const [proj, sink, b] = [p, engine, bus];
    close();
    const lane = b.laneFor(r.owner, r.target) ?? addLane(proj, sink, r.owner, r.target);
    if (!lane) {
      flashHint('No free automation lane: a project has at most 64');
      return;
    }
    if (isMasterChannel(r.owner)) {
      laneView.master = true;
      setOpen(MASTER_ROW, true);
    } else setOpen(r.owner, true);
    b.refresh();
    await tick();
    // AutoLane mirrors its engine lane (unique in the project) as data-lane.
    document.querySelector(`[data-testid^="auto-lane-"][data-lane="${lane.lane}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function learn() {
    const r = control;
    close();
    startLearn(r.owner, r.target, r.label);
  }

  function forget() {
    const r = control;
    const proj = p;
    close();
    forgetMidi(proj, r.owner, r.target);
  }

  /** ArrowUp / ArrowDown move between the items (wrapping). */
  function arrows(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(el?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  }
</script>

<div
  class="list"
  bind:this={el}
  data-testid="auto-ctl-menu"
  role="menu"
  tabindex="-1"
  aria-label={items.automate ? `Automation of ${control.label}` : `MIDI of ${control.label}`}
  onkeydown={arrows}
>
  {#if items.automate}
    <button
      role="menuitem"
      data-testid="auto-ctl-automate"
      title={exists ? 'Open its automation lane on the timeline' : 'Add an automation lane for it on the timeline'}
      onclick={() => void act()}
    >{exists ? 'Show automation' : 'Automate'}</button>
  {/if}
  {#if mapped}
    <button
      role="menuitem"
      data-testid="auto-ctl-midi"
      title={`Unbind MIDI CC ${mapped.cc} from it`}
      onclick={forget}
    >Forget MIDI (CC {mapped.cc})</button>
  {:else if items.midi}
    <button
      role="menuitem"
      data-testid="auto-ctl-midi"
      title="Then move a knob on your MIDI controller: its CC moves this control"
      onclick={learn}
    >MIDI learn</button>
  {/if}
</div>

<style>
  /* The rows on the popover's --panel card (ui-theme.md "Precise entry"). */
  .list { display: flex; flex-direction: column; }
  button {
    min-height: 28px; padding: 0 10px; border: 0; border-radius: var(--r-sm); text-align: left;
    background: transparent; color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); cursor: pointer;
  }
  button:hover, button:focus-visible { background: var(--raised); outline: none; }
</style>
