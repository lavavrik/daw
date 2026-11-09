<script lang="ts">
  // Track headers: the left column of the song timeline, one header per row
  // of the layout map (tlMath.rowLayout: the same rows, heights and order as
  // the lanes, so each header lines up with its row). One keyboard-
  // accessible button per track (plan-2 testid `track-<slot>`). Selection is
  // shown by a lighter background + a "▶" marker + bold name (not colour
  // alone); the second line says what the track is. The × only appears on
  // hover/focus and asks first (InlineConfirm popover under the ×; held piano
  // keys are released before it opens).
  // M / S on every header mute / solo the track: the same mixer flags as
  // the strip's M and S (state/mixer-actions toggleMute / toggleSolo), so the
  // two views always agree and each click is one undo entry. Solo = play
  // only the soloed tracks (the returns keep playing).
  //
  // AUTOMATION (plan 10). A on a track header shows / hides its automation
  // lanes (laneView.open: UI state, not saved); it shows how many it has.
  // Each lane row's header: the enable toggle (a disabled lane plays the
  // base value), the target ("Filter · Cutoff", "Fader": autoLabels.ts), ×
  // to remove the lane (one undo entry; no question: undo brings it back),
  // and on the owner's last lane row the "Automate…" button (AutoPicker.svelte,
  // plan 21 §9: a searchable, grouped popover of the targets; it replaced the
  // "+ Lane" <select> and keeps its test id). An open track without lanes
  // shows one empty lane row with just that button. While the pattern transport ran last (Pattern
  // mode) a lane header says lanes play with the song only. The Master row (pinned under the last track) holds the
  // master's and both returns' lanes; its own A, and × to hide it while it
  // has no lane (the timeline footer's "+ Add track" list shows it: "Master row").
  //
  // LANE HEIGHT (plan 19). Each lane row's header has a 5 px grab strip on
  // its bottom edge (`lane-resize-<laneId>`, a focusable horizontal
  // separator whose aria-valuenow is the height): dragging it sets the lane's
  // height live (laneView.setLaneHeight: clamped to LANE_MIN_H..LANE_MAX_H;
  // the timeline's layout map follows, so the header and the lane stay
  // aligned); double-click resets it to AUTO_H; ArrowUp / ArrowDown change it
  // by 8 px (Shift: 1 px). A height is UI state, not part of the project: no
  // undo entry, not dirty. Escape, a lost pointer capture, or Cmd/Ctrl+Z
  // mid-drag (registerDragCancel) put back the height from before the drag.
  // The empty lane row (no lane yet) has no strip: it is always AUTO_H.
  //
  // LOOK (plan 20, spec §4 Playlist): a 6 px colour bar in the track colour
  // (with the gloss), the name (and kind) over a thin volume slider, raised
  // M / S / A buttons (lit: M --accent, S --play, A the track colour). Tokens
  // only; the track colour is data, passed in as --c.
  //
  // VOLUME SLIDER: TrackVol.svelte (`track-vol-<slot>`, track rows only),
  // the track's mixer fader; it follows the fader's automation lane.
  //
  // TRACK ORDER (plan 22 Task 4; docs/architecture/arrangement.md "Track
  // order"). The order of p.tracks is the song's track order, and moving a
  // track is actions.moveTrack (one undo entry, no engine command). Three ways:
  //   - drag a track header vertically (from anywhere on it but the volume
  //     slider: the press only becomes a drag past DRAG_PX of vertical
  //     travel, so a click on the name, M / S / A or × still works, and the
  //     click that ends a real drag is swallowed). The track's block (its
  //     header and its open lane rows: tlMath.trackBlocks) dims in place, a
  //     ghost of the header follows the pointer, and an --accent line marks
  //     the gap it will drop into (tlMath.dropGap; none on its own two gaps,
  //     which are no move). The rows move on the drop (one write). Escape,
  //     Cmd/Ctrl+Z (registerDragCancel), a lost pointer, the window losing
  //     focus (blur) or unmounting cancel it. Near the top / bottom edge of
  //     the timeline's scroller (under the sticky ruler, above the sticky
  //     footer: `scroll` from Timeline) the view scrolls, faster the deeper in, like the rack's module drag;
  //   - Alt+Up / Alt+Down on the focused header button (the rack's nudge
  //     chord) moves it one place; quick presses are one undo entry
  //     (sweepKey `trackmove:<id>`, 1 s idle; settled after each press, so
  //     ↓ then ↑ leaves no entry), and focus stays on it;
  //   - the header's context menu (right-click, or the context-menu key):
  //     "Move up" / "Move down" (`track-menu-up` / `-down`).
  // Each move says "Moved <name> to position n of N" in the visually hidden
  // live region (`track-order-status`). Lane heights, the open lanes, the
  // selection etc. are keyed by track / lane id, so they travel with it.
  import { onDestroy, tick, untrack } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import type { Project, Track } from '../../state/project.svelte';
  import { removeTrackText } from '../../state/confirmText';
  import { moveTrack, removeTrack, selectTrack } from '../../state/actions';
  import { createSweepKeys } from '../../history/sweep';
  import { toggleMute, toggleSolo } from '../../state/mixer-actions';
  import TrackVol from './TrackVol.svelte';
  import { mixParam } from '../../audio/mixerCatalog';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { IS_MAC, soloTitle } from '../soloTitle';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { MAX_AUTO_LANES } from '../../audio/protocol';
  import { laneCount, projectLanes } from '../../state/automation';
  import type { AutoOwner } from '../../state/automation';
  import { removeLane, setLaneEnabled } from '../../state/automation-actions';
  import type { AutomationLane } from '../../state/project.svelte';
  import { targetLabel } from './autoLabels';
  import { findReturn, returnColor } from '../../state/returns';
  import AutoPicker from './AutoPicker.svelte';
  import { laneHeight, laneView, setLaneHeight, setOpen } from './laneView.svelte';
  import { AUTO_H, LANE_H, LANE_MAX_H, LANE_MIN_H, MASTER_GREY, MASTER_ROW, dropGap, gapIndex, gapY, rowsHeight, trackBlocks } from './tlMath';
  import type { Row } from './tlMath';

  let { p, engine, rows, scroll = null }: {
    p: Project;
    engine: CommandSink;
    rows: readonly Row[];
    /** The timeline's vertical scroller and its sticky top / bottom bands (px): where a reorder drag auto-scrolls. */
    scroll?: { el: HTMLElement | null; top: number; bottom: number } | null;
  } = $props();

  const full = $derived(laneCount(p) >= MAX_AUTO_LANES);
  const FULL = `${MAX_AUTO_LANES} lanes is the maximum: remove one to add another`;

  const trackById = $derived(new Map(p.tracks.map((t) => [t.id, t])));
  /** Every lane by id: its owner and its index among the owner's lanes (testids). */
  const laneInfo = $derived.by(() => {
    const m = new Map<string, { lane: AutomationLane; owner: AutoOwner; k: number }>();
    for (const t of p.tracks) t.automation.forEach((lane, k) => m.set(lane.id, { lane, owner: t, k }));
    p.mixer.automation.forEach((x, k) => m.set(x.lane.id, { lane: x.lane, owner: x.channel, k }));
    return m;
  });
  /** The testid key of a row's owner: the track's slot, or "m" for the Master row. */
  const ownerKey = (trackId: string) => (trackId === MASTER_ROW ? 'm' : String(trackById.get(trackId)?.slot ?? '?'));
  /** The owner's last row (where its "Automate…" button sits). */
  const isLastOfOwner = (i: number) => rows[i + 1]?.trackId !== rows[i].trackId || rows[i + 1]?.kind !== 'lane';

  /** The open question: which track, and the × that asked. */
  let asking = $state<{ track: Track; anchor: HTMLElement } | null>(null);

  /** A track's mixer flag (mute / solo) as shown on its strip. */
  const flagOn = (t: Track, n: 'mute' | 'solo') => (p.mixer.channels[t.id]?.params[mixParam(n).id] ?? mixParam(n).default) === 1;

  function remove(t: Track, anchor: HTMLElement) {
    releaseHeldKeys();
    asking = { track: t, anchor };
  }

  // ---- lane height (see LANE HEIGHT at the top) ----------------------------------
  /** The strip drag in progress: the lane, the press's y and the height before it. */
  let resizing: { laneId: string; y0: number; h0: number } | null = null;
  function resizeDown(e: PointerEvent, laneId: string) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no native drag
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true }); // Escape reaches resizeKey
    resizing = { laneId, y0: e.clientY, h0: laneHeight(laneId) };
    el.setPointerCapture(e.pointerId);
  }
  function resizeMove(e: PointerEvent) {
    const r = resizing;
    if (r) setLaneHeight(r.laneId, r.h0 + e.clientY - r.y0);
  }
  function resizeUp() {
    resizing = null; // first: the lostpointercapture that follows must not cancel
  }
  /** Abort the drag: the height from before it. False when no drag was on. */
  function resizeCancel(): boolean {
    const r = resizing;
    if (!r) return false;
    resizing = null;
    setLaneHeight(r.laneId, r.h0);
    return true;
  }
  // Cmd/Ctrl+Z or redo mid-drag cancels it like Escape (history/gestures.ts).
  const unregisterResize = registerDragCancel(resizeCancel);
  // Unmounting mid-resize (leaving the Song view) puts the height back too.
  onDestroy(() => {
    resizeCancel();
    unregisterResize();
  });
  function resizeKey(e: KeyboardEvent, laneId: string) {
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape' && resizing) {
      take();
      resizeCancel();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      take();
      const step = e.shiftKey ? 1 : 8;
      setLaneHeight(laneId, laneHeight(laneId) + (e.key === 'ArrowDown' ? step : -step));
    }
  }

  // ---- track order (see TRACK ORDER at the top) ----------------------------------
  /** Vertical travel (px) before a press on a header becomes a reorder drag. */
  const DRAG_PX = 4;
  /** Auto-scroll zone (px) at the scroller's top / bottom edge, and the most it scrolls per frame. */
  const EDGE = 30;
  const EDGE_STEP = 14;

  let headsEl = $state<HTMLDivElement | null>(null);
  const blocks = $derived(trackBlocks(rows));
  const sweepKey = createSweepKeys();

  /** The live region's text (cleared, then set a tick later, so the same news twice is still read out). */
  let orderStatus = $state('');
  function announce(text: string) {
    orderStatus = '';
    void tick().then(() => (orderStatus = text));
  }

  /** Move track `id` to index `to`: one write, the news, and focus kept on its header button when asked. */
  function moveTo(id: string, to: number, o: { coalesce?: string; refocus?: boolean } = {}) {
    const from = p.tracks.findIndex((t) => t.id === id);
    const t = p.tracks[from];
    if (!t || !moveTrack(p, from, to, { coalesce: o.coalesce })) return;
    // A coalesced (keyboard) move only marks the entry stale; settle now, so a
    // burst that nets to nothing (↓ then ↑) leaves no dead "Move track" entry.
    if (o.coalesce) p.history?.settle();
    announce(`Moved ${t.name} to position ${to + 1} of ${p.tracks.length}`);
    if (!o.refocus) return;
    // The keyed rows were re-ordered in the DOM, which can drop the focus: put it back.
    const slot = t.slot;
    void tick().then(() => {
      const b = headsEl?.querySelector<HTMLElement>(`[data-testid="track-${slot}"]`);
      b?.focus({ preventScroll: true });
      b?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Alt+Up / Alt+Down on a header button: one place (nothing at either end). */
  function orderKey(e: KeyboardEvent, t: Track) {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (reorder) return;
    const to = p.tracks.indexOf(t) + (e.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < p.tracks.length) moveTo(t.id, to, { coalesce: sweepKey(`trackmove:${t.id}`), refocus: true });
  }

  /**
   * The drag in progress (shown: `reorder`), and the press that may become
   * one (`press`, plain: no render needs it). `gap`: the drop gap, null on
   * the track's own gaps (no move); `y`: the pointer's content y; `grab`:
   * where the header was taken, from its top.
   */
  let reorder = $state<{ id: string; gap: number | null; y: number; grab: number } | null>(null);
  let press: { id: string; y0: number; clientY: number; pointerId: number; end: () => void } | null = null;
  let edgeRaf = 0;

  const dragged = $derived(reorder ? (p.tracks.find((t) => t.id === reorder!.id) ?? null) : null);
  /** Content y of the drop line, or null (no move there). */
  const lineY = $derived(reorder?.gap != null ? gapY(blocks, reorder.gap) : null);

  /** Pointer client y -> content y of the header column. */
  const contentY = (clientY: number) => clientY - (headsEl?.getBoundingClientRect().top ?? 0);

  /** Follow the pointer: the ghost and the drop gap. */
  function follow(clientY: number) {
    const d = reorder;
    if (!d) return;
    const from = p.tracks.findIndex((t) => t.id === d.id);
    const y = contentY(clientY);
    const gap = dropGap(blocks, y);
    d.y = y;
    d.gap = from >= 0 && gapIndex(from, gap) !== from ? gap : null;
  }

  // Edge auto-scroll (the rack's recipe): while the pointer is within EDGE px
  // of the scroller's visible rows (or past them), scroll toward that edge
  // each frame, faster the deeper in; the drop gap follows the scroll.
  function edgeScroll() {
    edgeRaf = 0;
    const el = scroll?.el;
    if (!reorder || !press || !el) return;
    const r = el.getBoundingClientRect();
    const top = r.top + scroll!.top;
    const bottom = r.bottom - scroll!.bottom;
    const y = press.clientY;
    const speed = (depth: number) => Math.ceil(EDGE_STEP * Math.min(1, depth / EDGE));
    const dy = y < top + EDGE ? -speed(top + EDGE - y) : y > bottom - EDGE ? speed(y - bottom + EDGE) : 0;
    if (!dy) return;
    const before = el.scrollTop;
    el.scrollBy(0, dy);
    if (el.scrollTop === before) return; // at the end
    follow(y);
    edgeRaf = requestAnimationFrame(edgeScroll);
  }

  function orderDown(e: PointerEvent, t: Track) {
    press?.end(); // a press whose release was lost
    if (e.button !== 0 || reorder) return;
    // The volume slider drags itself; macOS Ctrl+click is a right click (the menu).
    if ((e.target as HTMLElement).closest('input') || (IS_MAC && e.ctrlKey)) return;
    const el = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => {
      if (!press || ev.pointerId !== press.pointerId) return;
      press.clientY = ev.clientY;
      if (!reorder) {
        if (Math.abs(ev.clientY - press.y0) < DRAG_PX) return;
        const head = blocks.find((b) => b.trackId === press!.id);
        reorder = { id: press.id, gap: null, y: contentY(ev.clientY), grab: head ? contentY(press.y0) - head.top : LANE_H / 2 };
        if (el.isConnected) el.setPointerCapture(press.pointerId);
        window.addEventListener('keydown', esc, true);
      }
      follow(ev.clientY);
      if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScroll);
    };
    const up = (ev: PointerEvent) => {
      if (!press || ev.pointerId !== press.pointerId) return;
      const d = reorder;
      if (d) follow(ev.clientY);
      end();
      if (!d) return; // a click: the button under it handles it
      swallowClick();
      const from = p.tracks.findIndex((x) => x.id === d.id);
      if (from >= 0 && d.gap !== null) moveTo(d.id, gapIndex(from, d.gap));
    };
    const cancel = (ev: PointerEvent) => {
      if (press && ev.pointerId === press.pointerId) end();
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end();
    };
    // The window losing focus mid-drag (Cmd+Tab) may swallow the release: drop the drag then too.
    const blur = () => end();
    /** Stop listening and drop the drag (nothing was written). */
    function end() {
      if (edgeRaf) cancelAnimationFrame(edgeRaf);
      edgeRaf = 0;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', blur);
      if (press && el.hasPointerCapture(press.pointerId)) el.releasePointerCapture(press.pointerId);
      press = null;
      reorder = null;
    }
    press = { id: t.id, y0: e.clientY, clientY: e.clientY, pointerId: e.pointerId, end };
    // Window, capture phase: the moves reach us wherever the pointer goes, before any widget under it.
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur);
  }
  /** The click a real drag's release makes on the button under it is no click. */
  function swallowClick() {
    const stop = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 0); // no click came
  }
  /** Escape's twin for Cmd/Ctrl+Z or redo mid-drag (history/gestures.ts). */
  function orderCancel(): boolean {
    if (!reorder) return false;
    press?.end();
    return true;
  }
  const unregisterOrder = registerDragCancel(orderCancel);
  onDestroy(() => {
    press?.end();
    unregisterOrder();
  });

  // The header's context menu: "Move up" / "Move down".
  let menu = $state<{ x: number; y: number; id: string; from: HTMLElement | null } | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  const menuTrack = $derived(menu ? (p.tracks.find((t) => t.id === menu!.id) ?? null) : null);
  const menuAt = $derived(menuTrack ? p.tracks.indexOf(menuTrack) : -1);
  function orderMenu(e: MouseEvent, t: Track) {
    if (e.defaultPrevented) return; // the volume slider opened its own menu
    e.preventDefault();
    press?.end();
    const main = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-testid="track-${t.slot}"]`);
    // A keyboard-made contextmenu event has no pointer position: open it under the name.
    const kbd = e.clientX === 0 && e.clientY === 0;
    const r = main?.getBoundingClientRect();
    menu = { x: kbd ? (r?.left ?? 0) : e.clientX, y: kbd ? (r?.bottom ?? 0) : e.clientY, id: t.id, from: main };
  }
  function closeMenu() {
    const from = menu?.from;
    menu = null;
    from?.focus({ preventScroll: true });
  }
  function menuMove(d: -1 | 1) {
    const t = menuTrack;
    closeMenu();
    if (t) moveTo(t.id, p.tracks.indexOf(t) + d, { refocus: true });
  }
  function menuKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const items = [...(menuEl?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }
  // Keep the menu inside the window; focus its first item; an outside press closes it.
  $effect(() => {
    const m = menu;
    const me = menuEl;
    if (!m || !me) return;
    const r = me.getBoundingClientRect();
    const x = Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4));
    if (x !== m.x || y !== m.y) menu = { ...m, x, y };
  });
  $effect(() => {
    if (!menu) return;
    const me = menuEl;
    untrack(() => me?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    const onDown = (e: PointerEvent) => {
      if (me && !me.contains(e.target as Node)) menu = null;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });
</script>

{#snippet addPicker(trackId: string)}
  <AutoPicker {p} {engine} rowId={trackId} testKey={ownerKey(trackId)} disabled={full} title={full ? FULL : 'Add an automation lane: search or browse what it drives'} />
  {#if full}<span class="cap" data-testid="auto-full" title={FULL}>{MAX_AUTO_LANES} max</span>{/if}
{/snippet}

<div class="heads" class:ordering={!!reorder} bind:this={headsEl}>
  {#each rows as r, i (r.kind + r.trackId + (r.laneId ?? ''))}
    {#if r.kind === 'clips'}
      {@const t = trackById.get(r.trackId)!}
      {@const sel = t.id === p.selectedTrackId}
      {@const muted = flagOn(t, 'mute')}
      {@const soloed = flagOn(t, 'solo')}
      {@const open = laneView.open.has(t.id)}
      <!-- The drag's keyboard twin is Alt+arrows on the header button (TRACK ORDER). -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row"
        class:sel
        class:muted
        class:lifted={reorder?.id === t.id}
        style:--c={t.color}
        style:height="{r.h}px"
        onpointerdown={(e) => orderDown(e, t)}
        oncontextmenu={(e) => orderMenu(e, t)}
      >
        <span class="bar" aria-hidden="true"></span>
        <div class="body">
          <button
            class="main"
            data-testid={`track-${t.slot}`}
            aria-pressed={sel}
            title="{t.name} — {t.kind === 'drum' ? 'drum track' : t.kind === 'audio' ? 'audio track' : `synth track (${t.patchName})`}. Click to edit it below; drag (or Alt+↑/↓) to reorder."
            onkeydown={(e) => orderKey(e, t)}
            onclick={() => {
              selectTrack(p, engine, t.id);
              p.mixerOpen = false; // show this track's editor, not the mixer
            }}
          >
            <span class="mark">{sel ? '▶' : ''}</span>
            <b class="name">{t.name}</b>
            {#if t.kind === 'synth'}
              <span class="kind">Synth · {t.patchName}</span>
            {:else if t.kind === 'audio'}
              <!-- "Audio 2" already says it; a renamed track gets the kind line. -->
              {#if !/^audio/i.test(t.name)}<span class="kind">Audio track</span>{/if}
            {:else if !/^drum/i.test(t.name)}
              <!-- "Drums 2" already says it; a renamed track gets the kind line. -->
              <span class="kind">Drum track</span>
            {/if}
          </button>
          <!-- The track's mixer fader (TrackVol.svelte); --c (the track colour) fills it. -->
          <TrackVol {p} {engine} track={t} />
        </div>
        <span class="ms">
          <button type="button" class="m" class:lit={muted} aria-pressed={muted} aria-label={`Mute ${t.name}`} data-testid={`track-mute-${t.slot}`} title={muted ? `${t.name} is muted — click to unmute` : `Mute ${t.name}`} onclick={() => toggleMute(p, engine, t.id)}>M</button>
          <button type="button" class="s" class:lit={soloed} aria-pressed={soloed} aria-label={`Solo ${t.name}`} data-testid={`track-solo-${t.slot}`} title={soloTitle(t.name, soloed)} onclick={(e) => toggleSolo(p, engine, t.id, { additive: e.metaKey || e.ctrlKey || e.shiftKey })}>S</button>
          <button
            type="button"
            class="a"
            class:lit={open}
            class:has={t.automation.length > 0}
            aria-pressed={open}
            aria-label={`Automation lanes of ${t.name}`}
            data-testid={`track-auto-${t.slot}`}
            title={`${open ? 'Hide' : 'Show'} ${t.name}'s automation lanes (${t.automation.length})`}
            onclick={() => setOpen(t.id, !open)}
          >A</button>
        </span>
        <button class="x" aria-label={`Remove track ${t.name}`} title="Remove track" onclick={(e) => remove(t, e.currentTarget)}>×</button>
      </div>
    {:else if r.kind === 'master'}
      {@const open = laneView.open.has(MASTER_ROW)}
      <div class="row master" style:--c={MASTER_GREY} style:height="{r.h}px" data-testid="master-head">
        <span class="bar" aria-hidden="true"></span>
        <span class="main static">
          <span class="mark"></span>
          <b class="name">Master</b><span class="kind">{['Master', ...p.mixer.returns.map((x) => x.name)].join(' · ')}</span>
        </span>
        <span class="ms">
          <button
            type="button" class="a" class:lit={open} class:has={p.mixer.automation.length > 0} aria-pressed={open}
            aria-label="Automation lanes of the master and the returns" data-testid="master-auto"
            title={`${open ? 'Hide' : 'Show'} the master's and returns' automation lanes (${p.mixer.automation.length})`}
            onclick={() => setOpen(MASTER_ROW, !open)}
          >A</button>
        </span>
        {#if !p.mixer.automation.length}
          <button class="x" aria-label="Hide the Master row" title="Hide the Master row" onclick={() => (laneView.master = false)}>×</button>
        {/if}
      </div>
    {:else}
      {@const info = r.laneId ? laneInfo.get(r.laneId) : undefined}
      {@const key = ownerKey(r.trackId)}
      {@const color = r.trackId === MASTER_ROW ? MASTER_GREY : (trackById.get(r.trackId)?.color ?? MASTER_GREY)}
      <div class="row lane" class:compact={r.h < 40} class:lifted={reorder?.id === r.trackId} style:--c={color} style:height="{r.h}px" data-testid={info ? `auto-head-${key}-${info.k}` : `auto-head-${key}-new`}>
        {#if info}
          {@const label = targetLabel(p, info.owner, info.lane.target)}
          <div class="lrow">
            <button
              type="button" class="en" class:on={info.lane.enabled} aria-pressed={info.lane.enabled}
              aria-label={`${info.lane.enabled ? 'Disable' : 'Enable'} the ${label} lane`}
              data-testid={`auto-enable-${key}-${info.k}`}
              title={info.lane.enabled ? 'On: the lane drives its target (click: off, the base value plays)' : 'Off: the base value plays (click: on)'}
              onclick={() => setLaneEnabled(p, engine, info.lane.id, !info.lane.enabled)}
            >{info.lane.enabled ? '●' : '○'}</button>
            {#if typeof info.owner === 'string' && findReturn(p, info.owner)}
              <!-- A return's lane: a dot in the return's colour next to its name (the label starts with it). -->
              <span class="rdot" aria-hidden="true" style:background={returnColor(findReturn(p, info.owner)!.slot)}></span>
            {/if}
            <span class="target" title={label}>{label}</span>
            <button class="x" aria-label={`Remove the ${label} lane`} title="Remove this lane" data-testid={`auto-remove-${key}-${info.k}`} onclick={() => removeLane(p, engine, info.lane.id)}>×</button>
          </div>
        {:else}
          <div class="lrow"><span class="target none">No lanes yet</span></div>
        {/if}
        <div class="lrow">
          {#if isLastOfOwner(i)}{@render addPicker(r.trackId)}{/if}
          {#if p.playing && p.mode === 'pattern' && info}<span class="pat" title="Lanes play with the song: press Play in the top bar to hear them (the pattern transport ignores them)">Song only</span>{/if}
        </div>
        {#if info && r.laneId}
          {@const laneId = r.laneId}
          <!-- The grab strip (LANE HEIGHT at the top): a focusable separator, so a window-splitter widget. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
          <div
            class="resize"
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={r.h}
            aria-valuemin={LANE_MIN_H}
            aria-valuemax={LANE_MAX_H}
            aria-label={`Height of the ${targetLabel(p, info.owner, info.lane.target)} lane`}
            tabindex="0"
            data-testid={`lane-resize-${laneId}`}
            title="Drag to resize the lane · double-click: default height ({AUTO_H} px) · ↑/↓: 8 px (Shift: 1 px)"
            onpointerdown={(e) => resizeDown(e, laneId)}
            onpointermove={resizeMove}
            onpointerup={resizeUp}
            onpointercancel={resizeCancel}
            onlostpointercapture={resizeCancel}
            ondblclick={() => setLaneHeight(laneId, AUTO_H)}
            onkeydown={(e) => resizeKey(e, laneId)}
          ></div>
        {/if}
      </div>
    {/if}
  {/each}
  {#if p.tracks.length === 0}<p class="empty">No tracks yet</p>{/if}
  {#if reorder && dragged}
    <!-- The header being dragged follows the pointer; the line is where it drops (TRACK ORDER). -->
    <div
      class="ghost"
      data-testid="track-drag-ghost"
      aria-hidden="true"
      style:--c={dragged.color}
      style:top="{Math.max(0, Math.min(reorder.y - reorder.grab, rowsHeight(rows) - LANE_H))}px"
      style:height="{LANE_H}px"
    ><span class="bar"></span><b class="name">{dragged.name}</b></div>
    {#if lineY !== null}<div class="drop-line" data-testid="track-drop-line" aria-hidden="true" style:top="{lineY}px"></div>{/if}
  {/if}
  <p class="sr-only" data-testid="track-order-status" aria-live="polite">{orderStatus}</p>
</div>

{#if menu && menuTrack}
  <div
    class="menu"
    bind:this={menuEl}
    data-testid="track-menu"
    role="menu"
    tabindex="-1"
    style:left="{menu.x}px"
    style:top="{menu.y}px"
    onkeydown={menuKey}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <div class="menu-ttl">{menuTrack.name}</div>
    <button role="menuitem" data-testid="track-menu-up" disabled={menuAt <= 0} title="Alt+↑ on the track name" onclick={() => menuMove(-1)}>Move up</button>
    <button role="menuitem" data-testid="track-menu-down" disabled={menuAt >= p.tracks.length - 1} title="Alt+↓ on the track name" onclick={() => menuMove(1)}>Move down</button>
  </div>
{/if}

{#if asking}
  {@const a = asking}
  <!-- Says that the track's patterns and clips go with it (confirmText.ts). -->
  <InlineConfirm
    message={removeTrackText(a.track)}
    anchor={a.anchor}
    confirmLabel="Remove"
    oncancel={() => (asking = null)}
    onconfirm={() => {
      const id = a.track.id; // read before clearing: `a` follows `asking`
      asking = null;
      removeTrack(p, engine, id);
    }}
  />
{/if}

<style>
  /* Tokens only (theme.css); --c is the row's track colour (data). */
  .heads { position: relative; display: flex; flex-direction: column; background: var(--panel); }
  .row { box-sizing: border-box; display: flex; align-items: stretch; gap: 4px; padding-right: 2px; border-bottom: 1px solid var(--grid); border-right: 1px solid var(--line); background: var(--panel); }
  .row:hover, .row:focus-within { background: color-mix(in srgb, var(--panel), var(--text) 4%); }
  .row.sel { background: color-mix(in srgb, var(--panel), var(--text) 10%); }
  .bar { width: 6px; flex: none; background: var(--c) var(--gloss); box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.18); }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
  .main { min-width: 0; display: flex; align-items: baseline; gap: 4px; padding: 0 2px 0 0; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden; }
  .main:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .mark { width: 8px; flex: none; color: var(--accent); font-size: 8px; }
  .name { flex: none; max-width: 100%; color: var(--text); font-size: var(--fs-ctl); font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
  .row:not(.sel) .name { font-weight: 600; color: var(--text-2); }
  .kind { min-width: 0; color: var(--text-2); font-size: var(--fs-lbl); opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }
  .x { width: 16px; flex: none; padding: 0; border: 0; background: transparent; color: var(--text-2); font-size: 14px; cursor: pointer; opacity: 0; }
  .row:hover .x, .row:focus-within .x, .x:focus-visible { opacity: 1; }
  .x:hover { color: var(--rec); }
  .ms { flex: none; display: flex; align-items: center; gap: 3px; }
  /* Raised M / S / A: lit M is --accent, S --play, A the track colour; text on a lit button is --on-color. */
  .ms button { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 5px; background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text-2); font: 700 9px/18px var(--font-ui); cursor: pointer; }
  .ms button:hover { color: var(--text); }
  .ms button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .ms button.lit { color: var(--on-color); }
  .m.lit { background-color: var(--accent); box-shadow: var(--raised-shadow), 0 0 8px color-mix(in srgb, var(--accent) 40%, transparent); }
  .s.lit { background-color: var(--play); box-shadow: var(--raised-shadow), 0 0 8px color-mix(in srgb, var(--play) 40%, transparent); }
  .a.lit { background-color: var(--c); box-shadow: var(--raised-shadow), 0 0 8px color-mix(in srgb, var(--c) 40%, transparent); }
  .a.has:not(.lit) { color: var(--c); }
  .row.muted .name, .row.muted .kind { opacity: 0.5; }
  .main.static { flex: 1; cursor: default; align-self: center; padding-left: 0; }
  .rdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .row.master { background: color-mix(in srgb, var(--panel), var(--well) 25%); }
  .row.lane { position: relative; flex-direction: column; justify-content: center; gap: 2px; padding: 0 2px 0 12px; background: color-mix(in srgb, var(--panel), var(--well) 30%); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--c) 60%, transparent); }
  /* Under 40 px (LANE_MIN_H is 32) the two header lines close up so they still fit. */
  .row.lane.compact { gap: 0; }
  .row.lane.compact .lrow, .row.lane.compact .x, .row.lane.compact .en { height: 15px; line-height: 15px; }
  /* bottom: -1px: over the row's bottom border too, so the strip ends at the row's edge. */
  .resize { position: absolute; left: 0; right: 0; bottom: -1px; height: 5px; z-index: 1; cursor: row-resize; touch-action: none; outline: none; }
  .resize:hover, .resize:active { box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  .resize:focus-visible { box-shadow: inset 0 -2px 0 var(--accent); }
  .lrow { display: flex; align-items: center; gap: 4px; min-width: 0; height: 18px; }
  .target { flex: 1; min-width: 0; font-size: var(--fs-lbl); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .target.none { color: var(--text-2); font-weight: 400; }
  .row.lane .x { opacity: 0.7; height: 18px; }
  .en { width: 16px; height: 16px; flex: none; padding: 0; border: 0; background: transparent; color: var(--c); font-size: 11px; line-height: 16px; cursor: pointer; }
  .en:not(.on) { color: var(--text-2); opacity: 0.6; }
  .en:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  .cap { font-size: 9px; color: var(--rec); white-space: nowrap; }
  .pat { font-size: 9px; color: var(--accent); white-space: nowrap; }
  .empty { color: var(--text-2); margin: 0; padding: 6px 8px; }
  /* TRACK ORDER: a header press must not select its text (it may become a drag). */
  .row:not(.lane):not(.master) { user-select: none; -webkit-user-select: none; }
  .heads.ordering, .heads.ordering * { cursor: grabbing; }
  /* The dragged block stays in place, dimmed; the ghost (the header) follows the pointer. */
  .row.lifted { opacity: 0.35; }
  .ghost { position: absolute; left: 0; right: 0; z-index: 1; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding-right: 8px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: color-mix(in srgb, var(--panel), var(--text) 10%); box-shadow: var(--lift); opacity: 0.92; pointer-events: none; overflow: hidden; }
  .ghost .bar { align-self: stretch; }
  .ghost .name { color: var(--text); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* The drop line: 2 px of --accent across the column, centred on the gap, with a dot at its start. */
  .drop-line { position: absolute; left: 0; right: 0; z-index: 1; height: 2px; margin-top: -1px; background: var(--accent); box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 50%, transparent); pointer-events: none; }
  .drop-line::before { content: ''; position: absolute; left: 0; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  /* Context-menu padding as the menu bar's popovers (plan 22 "Menus": right >= 16 px, bottom >= 8 px); each
     item spans the inner width, so its highlight is the full band. */
  .menu { position: fixed; z-index: 50; min-width: 130px; padding: 6px 16px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift); display: flex; flex-direction: column; }
  .menu-ttl { font-size: var(--fs-lbl); color: var(--text-2); padding: 2px 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  .menu button { width: 100%; box-sizing: border-box; font: inherit; text-align: left; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text); cursor: pointer; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: var(--raised); outline: none; }
  .menu button:disabled { color: var(--text-2); opacity: 0.5; cursor: not-allowed; }
</style>
