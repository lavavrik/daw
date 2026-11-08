<script module lang="ts">
  // The in-app menu a right-click on a knob or fader opens (plan 10 Task 4,
  // plan 14 Task 3). Its items, in order:
  //   - "Automate" (no lane on that target yet: creates it, one undo entry)
  //     or "Show automation". Either way it opens the owner's lanes on the
  //     timeline (the track's A; the Master row for the returns and the
  //     master) and scrolls the lane into view. Only for continuous params
  //     (autoBus.canAutomate).
  //   - "MIDI learn" (ui/midiLearn.svelte.ts startLearn: the next CC binds
  //     to it) or, when the control has a CC, "Forget MIDI (CC 74)" (one
  //     undo entry). For continuous and integer params (canLearn), not
  //     choices or on/off flags.
  // The controls open it when either kind of item exists (menuItems); ArrowUp
  // / ArrowDown move between the items, Escape closes it. One menu for the
  // whole app, rendered by App; the controls call openAutoMenu.
  import type { MixChannelTarget } from '../state/mixer-actions';
  import type { AutoTarget } from '../state/project.svelte';
  import type { AutoBus } from './autoBus';

  export interface AutoMenuReq {
    x: number;
    y: number;
    owner: MixChannelTarget;
    target: AutoTarget;
    /** The control's accessible name ("Drums volume"), the menu's title. */
    label: string;
    /** Focus goes back here when the menu closes. */
    from: HTMLElement | null;
  }
  const menu = $state<{ req: AutoMenuReq | null }>({ req: null });

  export function openAutoMenu(req: AutoMenuReq) {
    menu.req = req;
  }

  /** Which items the menu would have for this control (a control opens it only when one is true). */
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

  let { p, engine, bus }: { p: Project; engine: CommandSink; bus: AutoBus } = $props();

  let el = $state<HTMLDivElement | null>(null);
  const req = $derived(menu.req);
  const exists = $derived(req ? bus.laneFor(req.owner, req.target) !== null : false);
  const items = $derived(req ? menuItems(bus, req.owner, req.target) : { automate: false, midi: false });
  /** The control's CC mapping ("Forget MIDI (CC 74)"), or null ("MIDI learn"). */
  const mapped = $derived(req ? mappingFor(p, req.owner, req.target) : null);
  /** Kept inside the window (the menu is about 180 x 90 px). */
  const left = $derived(req ? Math.max(4, Math.min(req.x, window.innerWidth - 190)) : 0);
  const top = $derived(req ? Math.max(4, Math.min(req.y, window.innerHeight - 96)) : 0);

  function close(refocus = true) {
    const from = menu.req?.from ?? null;
    menu.req = null;
    if (refocus) queueMicrotask(() => from?.focus());
  }

  async function act() {
    const r = menu.req;
    if (!r) return;
    close();
    const lane = bus.laneFor(r.owner, r.target) ?? addLane(p, engine, r.owner, r.target);
    if (!lane) {
      flashHint('No free automation lane: a project has at most 64');
      return;
    }
    if (isMasterChannel(r.owner)) {
      laneView.master = true;
      setOpen(MASTER_ROW, true);
    } else setOpen(r.owner, true);
    bus.refresh();
    await tick();
    // AutoLane mirrors its engine lane (unique in the project) as data-lane.
    document.querySelector(`[data-testid^="auto-lane-"][data-lane="${lane.lane}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function learn() {
    const r = menu.req;
    if (!r) return;
    close();
    startLearn(r.owner, r.target, r.label);
  }

  function forget() {
    const r = menu.req;
    if (!r) return;
    close();
    forgetMidi(p, r.owner, r.target);
  }

  // Focus the first item on open; a press anywhere else closes the menu.
  $effect(() => {
    if (!req || !el) return;
    el.querySelector<HTMLElement>('button')?.focus();
    const away = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) close(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  });

  function key(e: KeyboardEvent) {
    e.stopPropagation(); // not the QWERTY piano / transport while the menu is open
    if (e.key === 'Escape') {
      e.preventDefault();
      close(); // (stopped above: App's Esc-cancels-learn never sees it)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = [...(el?.querySelectorAll<HTMLElement>('button') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    }
  }
</script>

{#if req}
  <div
    class="menu"
    bind:this={el}
    data-testid="auto-ctl-menu"
    role="menu"
    tabindex="-1"
    aria-label={items.automate ? `Automation of ${req.label}` : `MIDI of ${req.label}`}
    style:left="{left}px"
    style:top="{top}px"
    onkeydown={key}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <div class="ttl">{req.label}</div>
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
{/if}

<style>
  .menu { position: fixed; z-index: 60; min-width: 140px; padding: 4px; background: #24262c; border: 1px solid #3a3d48; border-radius: 4px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; }
  .ttl { font-size: 10px; color: #8d90a0; padding: 2px 6px 4px; white-space: nowrap; }
  button { font: inherit; text-align: left; padding: 4px 8px; border: 0; border-radius: 3px; background: transparent; color: #e4e5ea; cursor: pointer; }
  button:hover, button:focus-visible { background: #343846; outline: none; }
</style>
