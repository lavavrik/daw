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
  //
  // Inline (plan 24): with `inline` set, the component renders only the item
  // list for that target, as the lower half of the precise-value popover
  // (ValuePopover.svelte): no card, no placement, no outside-press or Esc
  // handling (the popover owns those); `onclose` closes the host before an
  // item acts, as the floating menu closes itself. The list keeps the test
  // ids (`auto-ctl-menu` on the list, `auto-ctl-automate`, `auto-ctl-midi`)
  // and the arrow keys. The floating menu (openAutoMenu) is unchanged for
  // the controls that still use it.
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

  /** What the items act on (the floating menu's request, or the inline host's target). */
  type ItemsFor = Pick<AutoMenuReq, 'owner' | 'target' | 'label'>;

  let { p, engine, bus, inline = null, onclose = () => {} }: {
    p: Project;
    engine: CommandSink;
    bus: AutoBus;
    /** Render only the items for this target, inside a host (header). */
    inline?: ItemsFor | null;
    /** Inline: close the host (it returns the focus) before an item acts. */
    onclose?: () => void;
  } = $props();

  let el = $state<HTMLDivElement | null>(null);
  const req = $derived(menu.req);
  const cur = $derived<ItemsFor | null>(inline ?? req);
  const exists = $derived(cur ? bus.laneFor(cur.owner, cur.target) !== null : false);
  const items = $derived(cur ? menuItems(bus, cur.owner, cur.target) : { automate: false, midi: false });
  /** The control's CC mapping ("Forget MIDI (CC 74)"), or null ("MIDI learn"). */
  const mapped = $derived(cur ? mappingFor(p, cur.owner, cur.target) : null);
  /** Kept inside the window (the menu is about 180 x 90 px). */
  const left = $derived(req ? Math.max(4, Math.min(req.x, window.innerWidth - 190)) : 0);
  const top = $derived(req ? Math.max(4, Math.min(req.y, window.innerHeight - 96)) : 0);

  function close(refocus = true) {
    if (inline) {
      onclose();
      return;
    }
    const from = menu.req?.from ?? null;
    menu.req = null;
    if (refocus) queueMicrotask(() => from?.focus());
  }

  // Each item reads what it needs before close(): inline, closing the host
  // unmounts this component, and its props are not read after that.
  async function act() {
    const r = cur;
    if (!r) return;
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
    const r = cur;
    if (!r) return;
    close();
    startLearn(r.owner, r.target, r.label);
  }

  function forget() {
    const r = cur;
    if (!r) return;
    const proj = p;
    close();
    forgetMidi(proj, r.owner, r.target);
  }

  // Focus the first item on open; a press anywhere else closes the menu.
  // (Inline: the host focuses its field and handles outside presses.)
  $effect(() => {
    if (inline || !req || !el) return;
    el.querySelector<HTMLElement>('button')?.focus();
    const away = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) close(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  });

  /** ArrowUp / ArrowDown move between the items (wrapping). True when it was one. */
  function arrows(e: KeyboardEvent): boolean {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
    e.preventDefault();
    const all = [...(el?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    return true;
  }

  function key(e: KeyboardEvent) {
    e.stopPropagation(); // not the QWERTY piano / transport while the menu is open
    if (e.key === 'Escape') {
      e.preventDefault();
      close(); // (stopped above: App's Esc-cancels-learn never sees it)
    } else arrows(e);
  }
</script>

{#snippet itemButtons()}
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
{/snippet}

{#if inline}
  <!-- The popover's lower half: the items only (the host has the title, the keys' isolation and Esc). -->
  <div
    class="list"
    bind:this={el}
    data-testid="auto-ctl-menu"
    role="menu"
    tabindex="-1"
    aria-label={items.automate ? `Automation of ${inline.label}` : `MIDI of ${inline.label}`}
    onkeydown={arrows}
  >
    {@render itemButtons()}
  </div>
{:else if req}
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
    {@render itemButtons()}
  </div>
{/if}

<style>
  /* A light menu like the open <select> picker (theme.css): --text surface,
     dark text, the menu radius and the lift; hover/focus is --text-2. */
  .menu {
    position: fixed; z-index: 60; min-width: 140px; padding: 4px; display: flex; flex-direction: column;
    background: var(--text); color: var(--on-color); border-radius: var(--r-menu); box-shadow: var(--lift);
  }
  .ttl {
    padding: 4px 10px; white-space: nowrap; font: 600 var(--fs-lbl) var(--font-ui);
    letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.7;
  }
  button {
    min-height: 28px; padding: 0 10px; border: 0; border-radius: var(--r-sm); text-align: left;
    background: transparent; color: inherit; font: 500 var(--fs-ctl) var(--font-ui); cursor: pointer;
  }
  button:hover, button:focus-visible { background: var(--text-2); outline: none; }
  /* Inline, on the popover's --panel card: the same rows in the card's colours. */
  .list { display: flex; flex-direction: column; }
  .list button { color: var(--text); }
  .list button:hover, .list button:focus-visible { background: var(--raised); }
</style>
