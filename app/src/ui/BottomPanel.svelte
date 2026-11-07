<script module lang="ts">
  /** Synth tab chosen last; kept for the session (module scope), default Piano roll. */
  let lastSynthTab: 'pianoroll' | 'instrument' = 'pianoroll';
</script>

<script lang="ts">
  import type { Project } from '../state/project.svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import PatternPicker from './PatternPicker.svelte';
  import { onMount } from 'svelte';
  import { currentPattern } from '../state/project.svelte';
  import { patternPosAt } from '../state/song-actions';
  import StepGrid from './StepGrid.svelte';
  import Rack from './rack/Rack.svelte';
  import PianoRoll from './pianoroll/PianoRoll.svelte';
  import MixerView from './mixer/MixerView.svelte';
  import type { NoteInput } from '../input/noteInput';
  import { banners } from '../state/banners.svelte';
  import { clearDownload } from '../export/exportFlow';

  let { p, engine, clock, noteInput = null }: {
    p: Project;
    engine: AudioEngine;
    clock: AudioClock | null;
    /** Played-note bus (the piano roll's keyboard auditions through it). */
    noteInput?: NoteInput | null;
  } = $props();
  const track = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  // Which tab is shown follows the selected track's kind: drum -> Step grid;
  // synth -> Piano roll or Instrument, whichever was picked last this session.
  // The Mixer tab is enabled for any selection (or none) and shows the whole
  // mixer. `p.mixerOpen` (project state, so the timeline can reach it): clicking
  // a strip name inside the mixer keeps it open, but selecting a track from the
  // timeline's track headers closes it (TrackHeaders.svelte) so the bottom panel
  // shows that track's editor (the remembered Piano roll / Instrument tab, or
  // the Step grid).
  let synthTab = $state(lastSynthTab);
  const editorTab = $derived(track?.kind === 'synth' ? synthTab : track?.kind === 'drum' ? 'step' : null);
  const active = $derived(p.mixerOpen ? 'mixer' : editorTab);
  function pickSynthTab(t: 'pianoroll' | 'instrument') {
    synthTab = lastSynthTab = t;
    p.mixerOpen = false;
  }

  // Song-mode hint: shown while the edited pattern is not playing at the
  // playhead (no clip of it under the playhead, or stopped). It flips on and
  // off during playback, so it lives in the header's status line (fixed
  // height, toggled with visibility): the editor below must never move
  // because of it (a jumping grid causes misclicks).
  let songIdle = $state(false);
  onMount(() => {
    let raf = 0;
    const loop = () => {
      let idle = false;
      if (p.mode === 'song' && track) {
        const t = clock && p.playing ? clock.heardTicks() : NaN;
        idle = patternPosAt(track, track.currentPatternId, t) === null;
      }
      if (idle !== songIdle) songIdle = idle;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const songHint = 'Song mode plays clips — playhead shows where a clip of this pattern plays';

  // Banners show here (top of the body); any code can raise them via `banners`.
</script>

<section class="pane">
  <div class="head">
    {#if track}
      <span class="swatch" style:background={track.color}></span>
      <b data-testid="panel-title">{track.name} · {currentPattern(track).name}</b>
      <PatternPicker {p} {engine} {track} />
    {:else}
      <span class="none">No track selected</span>
    {/if}
    <!-- Status line: flashed hints (banners.hint) win over the Song-mode hint. -->
    <span class="status">
      <span class="hint" class:off={!songIdle || banners.hint !== null} data-testid="song-hint" title={songHint} aria-hidden={!songIdle || banners.hint !== null}>{songHint}</span>
      {#if banners.hint !== null}
        <span class="hint flash" data-testid="flash-hint" role="status">{banners.hint}</span>
      {/if}
    </span>
    <span class="tabs">
      <button class="tab" class:active={active === 'step'} disabled={track?.kind !== 'drum'} title={track?.kind === 'drum' ? '' : 'Select a drum track'} onclick={() => (p.mixerOpen = false)}>Step grid</button>
      <button class="tab" class:active={active === 'pianoroll'} disabled={track?.kind !== 'synth'} title={track?.kind === 'synth' ? '' : 'Select a synth track'} onclick={() => pickSynthTab('pianoroll')}>Piano roll</button>
      <button class="tab" class:active={active === 'instrument'} disabled={track?.kind !== 'synth'} title={track?.kind === 'synth' ? '' : 'Select a synth track'} onclick={() => pickSynthTab('instrument')}>Instrument</button>
      <button class="tab" class:active={active === 'mixer'} title="All tracks, the Reverb and Delay returns and the Master" data-testid="mixer-tab" onclick={() => (p.mixerOpen = true)}>Mixer</button>
    </span>
  </div>
  <div class="body">
    {#if banners.error}
      <div class="banner err" data-testid="banner" role="alert">
        <span>{banners.error}</span><button aria-label="Dismiss" onclick={() => (banners.error = null)}>×</button>
      </div>
    {/if}
    {#if banners.ask}
      {@const ask = banners.ask}
      <div class="banner note" data-testid="ask" role="alertdialog" aria-label={ask.text}>
        <span>{ask.text}</span>
        <button class="ok" data-testid="ask-ok" onclick={() => void ask.run()}>{ask.ok}</button>
        <button data-testid="ask-cancel" onclick={() => (banners.ask = null)}>Cancel</button>
      </div>
    {/if}
    {#if banners.load}
      <div class="banner note" data-testid="load-notice">
        <span>{banners.load}</span><button aria-label="Dismiss" onclick={() => (banners.load = null)}>×</button>
      </div>
    {/if}
    {#if banners.exporting}
      {@const ex = banners.exporting}
      <div class="banner note" data-testid="export-progress" role="status">
        <span>Exporting WAV… {Math.floor(ex.fraction * 100)}%</span>
        <progress max="1" value={ex.fraction}></progress>
        <button class="cancel" data-testid="export-cancel" onclick={() => ex.cancel()}>Cancel</button>
      </div>
    {/if}
    {#if banners.download}
      {@const dl = banners.download}
      <div class="banner note" data-testid="export-download">
        <span>Export ready: <a href={dl.href} download={dl.name} data-testid="export-download-link">Download “{dl.name}”</a></span>
        <button aria-label="Dismiss" onclick={clearDownload}>×</button>
      </div>
    {/if}
    {#if banners.notice}
      <div class="banner note" data-testid="notice">
        <span>{banners.notice}</span><button aria-label="Dismiss" onclick={() => (banners.notice = null)}>×</button>
      </div>
    {/if}
    {#if p.mixerOpen}
      <MixerView {p} {engine} />
    {:else if track && track.kind === 'drum'}
      <StepGrid {p} {engine} {clock} {track} onerror={(m) => (banners.error = m)} />
    {:else if track && track.kind === 'synth' && active === 'pianoroll'}
      {#key track.id}<PianoRoll {p} {engine} {clock} {track} {noteInput} />{/key}
    {:else if track && track.kind === 'synth'}
      {#key track.id}<Rack {p} {engine} {track} />{/key}
    {/if}
  </div>
</section>

<style>
  .pane { background: #1b1c21; border: 1px solid #2a2c33; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2a2c33; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; }
  .none { color: #7d808c; }
  .tabs { display: flex; gap: 2px; }
  /* Takes the free space between the picker and the tabs; children are
     absolutely placed, so their text never changes the header's size. */
  .status { position: relative; flex: 1 1 0; min-width: 0; align-self: stretch; }
  .status .hint { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); color: #9aa6c4; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status .hint.off { visibility: hidden; }
  .status .flash { color: #ffd98a; }
  .tab { font: inherit; font-size: 11px; padding: 3px 10px; border: 0; border-radius: 3px 3px 0 0; background: #24262c; color: #c9cbd3; }
  .tab.active { background: #f0a23a; color: #111; }
  .tab:disabled { opacity: 0.45; cursor: not-allowed; }
  .body { padding: 8px; overflow: auto; flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .banner { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 8px; margin-bottom: 6px; border-radius: 3px; }
  .banner button { font: inherit; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 14px; }
  .banner[data-testid='ask'] span { flex: 1; }
  .banner[data-testid='ask'] button { font-size: 12px; border: 1px solid currentColor; border-radius: 3px; padding: 1px 8px; }
  .banner progress { flex: 1; height: 8px; accent-color: #f0a23a; }
  .banner .cancel { font-size: 12px; border: 1px solid currentColor; border-radius: 3px; padding: 1px 8px; }
  .banner a { color: inherit; font-weight: 600; }
  .banner .ok { background: #f0a23a; color: #111; border-color: #f0a23a; font-weight: 600; }
  .err { background: #4a2024; color: #ffb3b8; border: 1px solid #7a3037; }
  .note { background: #2b2a1c; color: #ffd98a; border: 1px solid #5a512b; }
</style>
