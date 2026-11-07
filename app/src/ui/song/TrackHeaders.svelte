<script lang="ts">
  // Track headers: the left column of the song timeline, one row per lane
  // (LANE_H tall, so each header lines up with its lane). One keyboard-
  // accessible button per track (plan-2 testid `track-<slot>`). Selection is
  // shown by a lighter background + a "▶" marker + bold name (not colour
  // alone); the second line says what the track is. The × only appears on
  // hover/focus and asks first (InlineConfirm popover under the ×; held piano
  // keys are released before it opens).
  // M / S on every header mute / solo the track: the same mixer flags as
  // the strip's M and S (state/mixer-actions toggleMute / toggleSolo), so the
  // two views always agree and each click is one undo entry. Solo = play
  // only the soloed tracks (the returns keep playing).
  import type { CommandSink } from '../../state/actions';
  import type { Project, Track } from '../../state/project.svelte';
  import { removeTrackText } from '../../state/confirmText';
  import { removeTrack, selectTrack } from '../../state/actions';
  import { toggleMute, toggleSolo } from '../../state/mixer-actions';
  import { mixParam } from '../../audio/mixerCatalog';
  import { releaseHeldKeys } from '../../input/shortcuts';
  import InlineConfirm from '../InlineConfirm.svelte';
  import { LANE_H } from './tlMath';

  let { p, engine }: { p: Project; engine: CommandSink } = $props();

  /** The open question: which track, and the × that asked. */
  let asking = $state<{ track: Track; anchor: HTMLElement } | null>(null);

  /** A track's mixer flag (mute / solo) as shown on its strip. */
  const flagOn = (t: Track, n: 'mute' | 'solo') => (p.mixer.channels[t.id]?.params[mixParam(n).id] ?? mixParam(n).default) === 1;

  function remove(t: Track, anchor: HTMLElement) {
    releaseHeldKeys();
    asking = { track: t, anchor };
  }
</script>

<div class="heads" style:--lane-h="{LANE_H}px">
  {#each p.tracks as t (t.id)}
    {@const sel = t.id === p.selectedTrackId}
    {@const muted = flagOn(t, 'mute')}
    {@const soloed = flagOn(t, 'solo')}
    <div class="row" class:sel class:muted style:--c={t.color}>
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
          {:else if !/^drum/i.test(t.name)}
            <!-- "Drums 2" already says it; a renamed track gets the kind line. -->
            <span class="kind">Drum track</span>
          {/if}
        </span>
      </button>
      <span class="ms">
        <button type="button" class="m" class:lit={muted} aria-pressed={muted} aria-label={`Mute ${t.name}`} data-testid={`track-mute-${t.slot}`} title={muted ? `${t.name} is muted — click to unmute` : `Mute ${t.name}`} onclick={() => toggleMute(p, engine, t.id)}>M</button>
        <button type="button" class="s" class:lit={soloed} aria-pressed={soloed} aria-label={`Solo ${t.name}`} data-testid={`track-solo-${t.slot}`} title={soloed ? `${t.name} is soloed — click to unsolo` : `Solo ${t.name}: play only this track (and other soloed ones)`} onclick={() => toggleSolo(p, engine, t.id)}>S</button>
      </span>
      <button class="x" aria-label={`Remove track ${t.name}`} title="Remove track" onclick={(e) => remove(t, e.currentTarget)}>×</button>
    </div>
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
  .row { height: var(--lane-h); box-sizing: border-box; display: flex; align-items: stretch; border-left: 4px solid var(--c); border-bottom: 1px solid #16171b; background: #20222a; }
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
  .empty { color: #7d808c; margin: 0; padding: 6px 8px; }
</style>
