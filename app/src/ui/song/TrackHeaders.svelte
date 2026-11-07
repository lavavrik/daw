<script lang="ts">
  // Track headers: the left column of the song timeline, one row per lane
  // (LANE_H tall, so each header lines up with its lane). One keyboard-
  // accessible button per track (plan-2 testid `track-<slot>`). Selection is
  // shown by a lighter background + a "▶" marker + bold name (not colour
  // alone); the second line says what the track is. The × only appears on
  // hover/focus and asks first (confirmReleasingKeys: a piano key held during
  // the dialog would hang).
  import type { CommandSink } from '../../state/actions';
  import type { Project } from '../../state/project.svelte';
  import { removeTrack, selectTrack } from '../../state/actions';
  import { confirmReleasingKeys } from '../../input/shortcuts';
  import { LANE_H } from './tlMath';

  let { p, engine }: { p: Project; engine: CommandSink } = $props();

  function remove(id: string, name: string) {
    if (confirmReleasingKeys(`Remove track "${name}"?`)) removeTrack(p, engine, id);
  }
</script>

<div class="heads" style:--lane-h="{LANE_H}px">
  {#each p.tracks as t (t.id)}
    {@const sel = t.id === p.selectedTrackId}
    <div class="row" class:sel style:--c={t.color}>
      <button
        class="main"
        data-testid={`track-${t.slot}`}
        aria-pressed={sel}
        title="{t.name} — {t.kind === 'drum' ? 'drum track' : `synth track (${t.patchName})`}. Click to edit it below."
        onclick={() => selectTrack(p, engine, t.id)}
      >
        <span class="mark">{sel ? '▶' : ''}</span>
        <span class="txt">
          <b class="name">{t.name}</b>
          <span class="kind">{t.kind === 'drum' ? 'Drums' : `Synth · ${t.patchName}`}</span>
        </span>
      </button>
      <button class="x" aria-label={`Remove track ${t.name}`} title="Remove track" onclick={() => remove(t.id, t.name)}>×</button>
    </div>
  {/each}
  {#if p.tracks.length === 0}<p class="empty">No tracks yet</p>{/if}
</div>

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
  .empty { color: #7d808c; margin: 0; padding: 6px 8px; }
</style>
