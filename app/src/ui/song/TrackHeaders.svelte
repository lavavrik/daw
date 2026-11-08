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
  import { onDestroy } from 'svelte';
  import { registerDragCancel } from '../../history/gestures';
  import type { CommandSink } from '../../state/actions';
  import type { Project, Track } from '../../state/project.svelte';
  import { removeTrackText } from '../../state/confirmText';
  import { removeTrack, selectTrack } from '../../state/actions';
  import { toggleMute, toggleSolo } from '../../state/mixer-actions';
  import TrackVol from './TrackVol.svelte';
  import { mixParam } from '../../audio/mixerCatalog';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import { soloTitle } from '../soloTitle';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { MAX_AUTO_LANES } from '../../audio/protocol';
  import { laneCount, projectLanes } from '../../state/automation';
  import type { AutoOwner } from '../../state/automation';
  import { removeLane, setLaneEnabled } from '../../state/automation-actions';
  import type { AutomationLane } from '../../state/project.svelte';
  import { targetLabel } from './autoLabels';
  import AutoPicker from './AutoPicker.svelte';
  import { laneHeight, laneView, setLaneHeight, setOpen } from './laneView.svelte';
  import { AUTO_H, LANE_MAX_H, LANE_MIN_H, MASTER_GREY, MASTER_ROW } from './tlMath';
  import type { Row } from './tlMath';

  let { p, engine, rows }: { p: Project; engine: CommandSink; rows: readonly Row[] } = $props();

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
</script>

{#snippet addPicker(trackId: string)}
  <AutoPicker {p} {engine} rowId={trackId} testKey={ownerKey(trackId)} disabled={full} title={full ? FULL : 'Add an automation lane: search or browse what it drives'} />
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
        <span class="bar" aria-hidden="true"></span>
        <div class="body">
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
          <b class="name">Master</b><span class="kind">Master · Reverb · Delay</span>
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
  /* Tokens only (theme.css); --c is the row's track colour (data). */
  .heads { display: flex; flex-direction: column; background: var(--panel); }
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
</style>
