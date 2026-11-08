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
  // and on the owner's last lane row the "+ Lane" <select> of the targets
  // that have no lane yet. An open track without lanes shows one empty lane
  // row with just the select. In Pattern mode a lane header says it plays in
  // SONG only. The Master row (pinned under the last track) holds the
  // master's and both returns' lanes; its own A, and × to hide it while it
  // has no lane (the timeline footer's "+ Master row" shows it).
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
  import { onDestroy } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import type { Project, Track } from '../../state/project.svelte';
  import { removeTrackText } from '../../state/confirmText';
  import { removeTrack, selectTrack } from '../../state/actions';
  import { toggleMute, toggleSolo } from '../../state/mixer-actions';
  import { mixParam } from '../../audio/mixerCatalog';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { MAX_AUTO_LANES } from '../../audio/protocol';
  import { laneCount, projectLanes } from '../../state/automation';
  import type { AutoOwner } from '../../state/automation';
  import { addLane, removeLane, setLaneEnabled } from '../../state/automation-actions';
  import type { AutoTarget, AutomationLane, MasterChannel } from '../../state/project.svelte';
  import { laneChoices, targetLabel } from './autoLabels';
  import { laneHeight, laneView, setLaneHeight, setOpen } from './laneView.svelte';
  import { AUTO_H, LANE_MAX_H, LANE_MIN_H, MASTER_GREY, MASTER_ROW } from './tlMath';
  import type { Row } from './tlMath';

  let { p, engine, rows }: { p: Project; engine: CommandSink; rows: readonly Row[] } = $props();

  const CHANNELS: MasterChannel[] = ['master', 'reverb', 'delay'];
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
  /** The owner's last row (where its "+ Lane" select sits). */
  const isLastOfOwner = (i: number) => rows[i + 1]?.trackId !== rows[i].trackId || rows[i + 1]?.kind !== 'lane';

  /** "+ Lane" options for a row's owner, each with the owner it adds to (Master row: one per channel). */
  function choices(trackId: string): { group: string | null; items: { owner: string; target: AutoTarget; label: string }[] }[] {
    if (trackId === MASTER_ROW) {
      const used = (c: MasterChannel) => p.mixer.automation.filter((x) => x.channel === c).map((x) => x.lane.target);
      return CHANNELS.map((c) => ({ group: c[0].toUpperCase() + c.slice(1), items: laneChoices(c, used(c)).map((x) => ({ owner: c, ...x })) }));
    }
    const t = trackById.get(trackId);
    if (!t) return [];
    return [{ group: null, items: laneChoices(t, t.automation.map((l) => l.target)).map((x) => ({ owner: t.id, ...x })) }];
  }
  function pick(e: Event & { currentTarget: HTMLSelectElement }, trackId: string) {
    const sel = e.currentTarget;
    const [g, i] = sel.value.split(':').map(Number);
    sel.value = '';
    const item = choices(trackId)[g]?.items[i];
    if (item) addLane(p, engine, item.owner, item.target);
  }

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
</script>

{#snippet addSelect(trackId: string)}
  {@const groups = choices(trackId)}
  <select
    class="add"
    data-testid="auto-add-{ownerKey(trackId)}"
    aria-label="Add an automation lane"
    title={full ? FULL : 'Add an automation lane: choose what it drives'}
    disabled={full}
    onchange={(e) => pick(e, trackId)}
  >
    <option value="">+ Lane</option>
    {#each groups as grp, g (g)}
      {#if grp.group}
        <optgroup label={grp.group}>
          {#each grp.items as it, i (i)}<option value="{g}:{i}">{it.label}</option>{/each}
        </optgroup>
      {:else}
        {#each grp.items as it, i (i)}<option value="{g}:{i}">{it.label}</option>{/each}
      {/if}
    {/each}
  </select>
  {#if full}<span class="cap" data-testid="auto-full" title={FULL}>{MAX_AUTO_LANES} max</span>{/if}
{/snippet}

<div class="heads">
  {#each rows as r, i (r.kind + r.trackId + (r.laneId ?? ''))}
    {#if r.kind === 'clips'}
      {@const t = trackById.get(r.trackId)!}
      {@const sel = t.id === p.selectedTrackId}
      {@const muted = flagOn(t, 'mute')}
      {@const soloed = flagOn(t, 'solo')}
      {@const open = laneView.open.has(t.id)}
      <div class="row" class:sel class:muted style:--c={t.color} style:height="{r.h}px">
        <button
          class="main"
          data-testid={`track-${t.slot}`}
          aria-pressed={sel}
          title="{t.name} — {t.kind === 'drum' ? 'drum track' : t.kind === 'audio' ? 'audio track' : `synth track (${t.patchName})`}. Click to edit it below."
          onclick={() => {
            selectTrack(p, engine, t.id);
            p.mixerOpen = false; // show this track's editor, not the mixer
          }}
        >
          <span class="mark">{sel ? '▶' : ''}</span>
          <span class="txt">
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
          </span>
        </button>
        <span class="ms">
          <button type="button" class="m" class:lit={muted} aria-pressed={muted} aria-label={`Mute ${t.name}`} data-testid={`track-mute-${t.slot}`} title={muted ? `${t.name} is muted — click to unmute` : `Mute ${t.name}`} onclick={() => toggleMute(p, engine, t.id)}>M</button>
          <button type="button" class="s" class:lit={soloed} aria-pressed={soloed} aria-label={`Solo ${t.name}`} data-testid={`track-solo-${t.slot}`} title={soloed ? `${t.name} is soloed — click to unsolo` : `Solo ${t.name}: play only this track (and other soloed ones)`} onclick={() => toggleSolo(p, engine, t.id)}>S</button>
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
        <span class="main static">
          <span class="mark"></span>
          <span class="txt"><b class="name">Master</b><span class="kind">Master · Reverb · Delay</span></span>
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
      <div class="row lane" class:compact={r.h < 40} style:--c={color} style:height="{r.h}px" data-testid={info ? `auto-head-${key}-${info.k}` : `auto-head-${key}-new`}>
        {#if info}
          {@const label = targetLabel(info.owner, info.lane.target)}
          <div class="lrow">
            <button
              type="button" class="en" class:on={info.lane.enabled} aria-pressed={info.lane.enabled}
              aria-label={`${info.lane.enabled ? 'Disable' : 'Enable'} the ${label} lane`}
              data-testid={`auto-enable-${key}-${info.k}`}
              title={info.lane.enabled ? 'On: the lane drives its target (click: off, the base value plays)' : 'Off: the base value plays (click: on)'}
              onclick={() => setLaneEnabled(p, engine, info.lane.id, !info.lane.enabled)}
            >{info.lane.enabled ? '●' : '○'}</button>
            <span class="target" title={label}>{label}</span>
            <button class="x" aria-label={`Remove the ${label} lane`} title="Remove this lane" data-testid={`auto-remove-${key}-${info.k}`} onclick={() => removeLane(p, engine, info.lane.id)}>×</button>
          </div>
        {:else}
          <div class="lrow"><span class="target none">No lanes yet</span></div>
        {/if}
        <div class="lrow">
          {#if isLastOfOwner(i)}{@render addSelect(r.trackId)}{/if}
          {#if p.mode === 'pattern' && info}<span class="pat" title="Lanes are editable in Pattern mode but play only in Song mode (SONG, Shift+L)">SONG only</span>{/if}
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
            aria-label={`Height of the ${targetLabel(info.owner, info.lane.target)} lane`}
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
</div>

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
  .heads { display: flex; flex-direction: column; }
  .row { box-sizing: border-box; display: flex; align-items: stretch; border-left: 4px solid var(--c); border-bottom: 1px solid #16171b; background: #20222a; }
  .row:hover, .row:focus-within { background: #272a33; }
  .row.sel { background: #343846; box-shadow: inset 0 0 0 1px #4a4f63; }
  .main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 0 4px 0 2px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .main:focus-visible, .x:focus-visible { outline: 2px solid #f0a23a; outline-offset: -2px; }
  .mark { width: 9px; flex: none; color: #f0a23a; font-size: 8px; }
  .txt { min-width: 0; display: flex; flex-direction: column; line-height: 1.1; }
  .name { color: #e6e7ec; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row:not(.sel) .name { font-weight: 500; color: #c9cbd3; }
  .kind { color: #8d90a0; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .x { width: 20px; flex: none; border: 0; background: transparent; color: #9a9dab; font-size: 14px; cursor: pointer; opacity: 0; }
  .row:hover .x, .row:focus-within .x, .x:focus-visible { opacity: 1; }
  .x:hover { color: #ff8a92; }
  .ms { flex: none; display: flex; align-items: center; gap: 2px; padding: 0 2px; }
  .ms button { width: 16px; height: 16px; padding: 0; border: 1px solid #3a3d48; border-radius: 3px; background: #1a1b20; color: #8d90a0; font: inherit; font-size: 9px; font-weight: 700; line-height: 14px; cursor: pointer; }
  .ms button:focus-visible { outline: 2px solid #f0a23a; outline-offset: 0; }
  .m.lit { background: #e0a030; border-color: #e0a030; color: #111; }
  .s.lit { background: #4fb3e0; border-color: #4fb3e0; color: #111; }
  .row.muted .txt { opacity: 0.5; }
  .a.lit { background: #8fd18f; border-color: #8fd18f; color: #111; }
  .a.has:not(.lit) { color: #8fd18f; border-color: #4d6b4d; }
  .main.static { cursor: default; }
  .row.master { background: #262830; }
  .row.lane { position: relative; flex-direction: column; justify-content: center; gap: 2px; padding: 0 2px 0 6px; background: #1b1c22; }
  /* Under 40 px (LANE_MIN_H is 32) the two header lines close up so they still fit. */
  .row.lane.compact { gap: 0; }
  .row.lane.compact .lrow, .row.lane.compact .add, .row.lane.compact .x, .row.lane.compact .en { height: 15px; line-height: 15px; }
  /* bottom: -1px: over the row's bottom border too, so the strip ends at the row's edge. */
  .resize { position: absolute; left: 0; right: 0; bottom: -1px; height: 5px; z-index: 1; cursor: row-resize; touch-action: none; outline: none; }
  .resize:hover, .resize:active { box-shadow: inset 0 -2px 0 #f0a23a88; }
  .resize:focus-visible { box-shadow: inset 0 -2px 0 #f0a23a; }
  .lrow { display: flex; align-items: center; gap: 4px; min-width: 0; height: 18px; }
  .target { flex: 1; min-width: 0; font-size: 10px; color: #c9cbd3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .target.none { color: #7d808c; }
  .row.lane .x { opacity: 0.6; height: 18px; }
  .en { width: 16px; height: 16px; flex: none; padding: 0; border: 0; background: transparent; color: var(--c); font-size: 11px; line-height: 16px; cursor: pointer; }
  .en:not(.on) { color: #6d707c; }
  .en:focus-visible, .add:focus-visible { outline: 2px solid #f0a23a; outline-offset: 0; }
  .add { max-width: 84px; height: 18px; font: inherit; font-size: 10px; padding: 0 2px; border: 1px solid #3a3d48; border-radius: 3px; background: #24262c; color: #c9cbd3; cursor: pointer; }
  .add:disabled { color: #6d707c; cursor: not-allowed; }
  .cap { font-size: 9px; color: #ff8a92; white-space: nowrap; }
  .pat { font-size: 9px; color: #ffd98a; white-space: nowrap; }
  .empty { color: #7d808c; margin: 0; padding: 6px 8px; }
</style>
