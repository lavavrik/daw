<script module lang="ts">
  /** Synth tab chosen last; kept for the session (module scope), default Piano roll. */
  let lastSynthTab: 'pianoroll' | 'acid' | 'instrument' = 'pianoroll';
</script>

<script lang="ts">
  import type { Project } from '../state/project.svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import PatternPicker from './PatternPicker.svelte';
  import PatternTransport from './PatternTransport.svelte';
  import type { Recorder, RecStatus } from '../state/recorder';
  import { onMount } from 'svelte';
  import { currentPattern, isPatternTrack } from '../state/project.svelte';
  import { patternPosAt } from '../state/song-actions';
  import StepGrid from './StepGrid.svelte';
  import Rack from './rack/Rack.svelte';
  import PianoRoll from './pianoroll/PianoRoll.svelte';
  import AcidSteps from './acid/AcidSteps.svelte';
  import Wheels from './Wheels.svelte';
  import MixerView from './mixer/MixerView.svelte';
  import ClipPanel from './ClipPanel.svelte';
  import { clipFocus, sampleName } from './song/clipFocus.svelte';
  import { tabFor } from '../input/shortcuts';
  import type { PanelTab } from '../input/shortcuts';
  import type { NoteInput } from '../input/noteInput';
  import { banners, flashHint } from '../state/banners.svelte';
  import { clearDownload } from '../export/exportFlow';

  let {
    p, engine, clock, noteInput = null, capturing = () => false,
    recorder = null, rec = null, onPatternPlay = () => {}, onPatternStop = () => {}, onToggleArm = () => {},
  }: {
    p: Project;
    engine: AudioEngine;
    clock: AudioClock | null;
    /** Played-note bus (the piano roll's keyboard and the Acid key strip audition through it). */
    noteInput?: NoteInput | null;
    /** True while the recorder captures live notes (the Acid tab's step entry pauses). */
    capturing?: () => boolean;
    /** The header's pattern transport (PatternTransport.svelte) shows once the App has a recorder. */
    recorder?: Recorder | null;
    /** Recorder status, refreshed every frame by the App. */
    rec?: RecStatus | null;
    /** Pattern transport Play / Stop and Rec (the App: recorder, count-in). */
    onPatternPlay?: () => void;
    onPatternStop?: () => void;
    onToggleArm?: () => void;
  } = $props();
  const track = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  /** The selected track when it plays patterns (an Audio track has none). */
  const ptrack = $derived(track && isPatternTrack(track) ? track : null);
  // Which tab is shown follows the selected track's kind: drum -> Step grid;
  // synth -> Piano roll, Acid (plan 17: the same pattern as steps) or
  // Instrument, whichever was picked last this session.
  // The Mixer tab is enabled for any selection (or none) and shows the whole
  // mixer. `p.mixerOpen` (project state, so the timeline can reach it): clicking
  // a strip name inside the mixer keeps it open, but selecting a track from the
  // timeline's track headers closes it (TrackHeaders.svelte) so the bottom panel
  // shows that track's editor (the remembered Piano roll / Instrument tab, or
  // the Step grid). An Audio track (plan 9) has one editor, the Clip tab
  // (ClipPanel: the clip the timeline focused); Step grid, Piano roll, Acid
  // and Instrument are disabled for it, with their usual tooltips.
  let synthTab = $state(lastSynthTab);
  const editorTab = $derived(
    track?.kind === 'synth' ? synthTab : track?.kind === 'drum' ? 'step' : track?.kind === 'audio' ? 'clip' : null,
  );
  /** The Audio track's focused clip (the Clip tab edits it; the header names it). */
  const audioClip = $derived(track?.kind === 'audio' ? (track.clips.find((c) => c.id === clipFocus.id) ?? null) : null);
  const audioClipName = $derived(
    audioClip ? sampleName(p, audioClip.sampleId) : null,
  );
  const active = $derived(p.mixerOpen ? 'mixer' : editorTab);
  function pickSynthTab(t: 'pianoroll' | 'acid' | 'instrument') {
    synthTab = lastSynthTab = t;
    p.mixerOpen = false;
  }

  /**
   * Keyboard tab pick (Alt+1..6, F6..F9; App calls this). A tab that is
   * disabled for the selected track (shortcuts.ts tabFor) does nothing but
   * flash its tooltip text in the status line; the selection is never
   * changed. A keyboard cable pick-up in the Rack ends with the Rack
   * unmounting (it clears itself).
   */
  export function pickTab(t: PanelTab) {
    const ok = tabFor(t, track?.kind ?? null);
    if ('hint' in ok) return flashHint(ok.hint);
    if (t === 'mixer') p.mixerOpen = true;
    else if (t === 'pianoroll' || t === 'acid' || t === 'instrument') pickSynthTab(t);
    else p.mixerOpen = false; // Step grid / Clip: the track's only editor
  }

  // Song-mode hint: shown while the edited pattern is not playing at the
  // playhead (no clip of it under the playhead, or stopped). It flips on and
  // off during playback, so it is an overlay pill just under the header's
  // right end (toggled with visibility, clicks pass through): the editor
  // below must never move because of it (a jumping grid causes misclicks).
  // Since the pattern transport (plan 20) the header has no room for it.
  let songIdle = $state(false);
  onMount(() => {
    let raf = 0;
    const loop = () => {
      let idle = false;
      if (p.mode === 'song' && ptrack) {
        const t = clock && p.playing ? clock.heardTicks() : NaN;
        idle = patternPosAt(ptrack, ptrack.currentPatternId, t) === null;
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
    {#if ptrack}
      <span class="swatch" style:background={ptrack.color}></span>
      <b data-testid="panel-title">{ptrack.name} · {currentPattern(ptrack).name}</b>
    {:else if track}
      <span class="swatch" style:background={track.color}></span>
      <b data-testid="panel-title">{track.name}{audioClipName ? ` · ${audioClipName}` : ''}</b>
    {:else}
      <span class="none">No track selected</span>
    {/if}
    <!-- Pattern transport (plan 20): beside the picker; disabled without a pattern track. -->
    {#if recorder && rec}
      <PatternTransport
        {p} track={ptrack} audio={track?.kind === 'audio'} {clock} {recorder} {rec}
        onPlay={onPatternPlay} onStop={onPatternStop} {onToggleArm}
      />
    {/if}
    {#if ptrack}
      <PatternPicker {p} {engine} track={ptrack} />
    {/if}
    <!-- The Song-mode hint: an overlay under the header's right end (hidden while a flashed hint shows). -->
    <span class="songhint" class:off={!songIdle || banners.hint !== null} data-testid="song-hint" title={songHint} aria-hidden={!songIdle || banners.hint !== null}>{songHint}</span>
    <!-- A flashed hint (banners.hint) overlays the header's right end for its
         few seconds (the header has no free room since the pattern transport,
         plan 20). It never moves the layout and lets clicks through to the
         tabs under it. -->
    {#if banners.hint !== null}
      <span class="flash" data-testid="flash-hint" role="status">{banners.hint}</span>
    {/if}
    <span class="tabs">
      <button class="tab" class:active={active === 'step'} disabled={track?.kind !== 'drum'} title={track?.kind === 'drum' ? 'Alt+1 / F6' : 'Select a drum track (Alt+1 / F6)'} onclick={() => (p.mixerOpen = false)}>Step grid</button>
      <button class="tab" class:active={active === 'pianoroll'} disabled={track?.kind !== 'synth'} title={track?.kind === 'synth' ? 'Alt+2 / F7' : 'Select a synth track (Alt+2 / F7)'} onclick={() => pickSynthTab('pianoroll')}>Piano roll</button>
      <!-- Alt+N is the Nth tab (shortcuts.ts TAB_CODES); Acid and Clip have no F-key. -->
      <button class="tab" class:active={active === 'acid'} disabled={track?.kind !== 'synth'} data-testid="tab-acid" title={track?.kind === 'synth' ? 'The pattern as steps (Alt+3)' : 'Select a synth track (Alt+3)'} onclick={() => pickSynthTab('acid')}>Acid</button>
      <button class="tab" class:active={active === 'instrument'} disabled={track?.kind !== 'synth'} title={track?.kind === 'synth' ? 'Alt+4 / F8' : 'Select a synth track (Alt+4 / F8)'} onclick={() => pickSynthTab('instrument')}>Instrument</button>
      <button class="tab" class:active={active === 'mixer'} title="All tracks, the Reverb and Delay returns and the Master (Alt+5 / F9)" data-testid="mixer-tab" onclick={() => (p.mixerOpen = true)}>Mixer</button>
      <button class="tab" class:active={active === 'clip'} disabled={track?.kind !== 'audio'} data-testid="tab-clip" title={track?.kind === 'audio' ? 'The selected audio clip: gain, fades, loop (Alt+6)' : 'Select an audio track (Alt+6)'} onclick={() => (p.mixerOpen = false)}>Clip</button>
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
    {:else if track && track.kind === 'synth'}
      <!-- The Pitch / Mod wheels sit left of every synth editor, like a
           keyboard's wheels beside its keys (ui/Wheels.svelte). -->
      <div class="synth">
        <Wheels {engine} {track} />
        <div class="editor">
          {#if active === 'pianoroll'}
            {#key track.id}<PianoRoll {p} {engine} {clock} {track} {noteInput} />{/key}
          {:else if active === 'acid'}
            {#key track.id}<AcidSteps {p} {engine} {clock} {track} {noteInput} {capturing} />{/key}
          {:else}
            {#key track.id}<Rack {p} {engine} {track} onpianoroll={() => pickSynthTab('pianoroll')} />{/key}
          {/if}
        </div>
      </div>
    {:else if track && track.kind === 'audio'}
      <ClipPanel {p} {engine} {clock} {track} />
    {/if}
  </div>
</section>

<style>
  /* Look (spec §4 "Bottom panel"; Main board): --panel under a --well rule;
     the header carries the track chip and name, the pattern transport and
     picker, and the tabs on a --work tray (theme.css .tabs). Tokens only. */
  .pane { background: var(--panel); border-top: 2px solid var(--well); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  /* One row from 1280 px (the title ellipsizes first); narrower, the tabs wrap
     onto a second row instead of running off the panel (layout.spec at 1024). */
  .head { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .head > * { flex: none; }
  .head > b { font: 700 var(--fs-body) var(--font-ui); color: var(--text); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 1279px) { .head { flex-wrap: wrap; row-gap: 4px; } }
  .swatch { width: 12px; height: 12px; border-radius: var(--r-xs); box-shadow: var(--raised-shadow); }
  .none { color: var(--text-2); }
  .tabs { margin-left: auto; padding: 2px; border-radius: var(--r-menu); background: var(--work); }
  /* Takes the free space between the picker and the tabs; children are
     absolutely placed, so their text never changes the header's size. */
  .songhint {
    position: absolute; top: calc(100% + 4px); right: 8px; z-index: 2;
    max-width: calc(100% - 16px); padding: 2px 8px; border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--well) 85%, transparent); color: var(--text-dim);
    font-size: var(--fs-ctl); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
  .songhint.off { visibility: hidden; }
  .flash {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%); z-index: 2;
    max-width: calc(100% - 16px); padding: 3px 10px; border-radius: var(--r-sm);
    background: var(--well); box-shadow: var(--lift); color: var(--accent);
    font-size: var(--fs-ctl); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
  /* The tabs are theme.css .tabs (selected = light, dark text), denser than
     the board's 30 px so the header stays one row under 40 px at 1280 px
     (layout.spec) beside the pattern transport. */
  .tab { padding: 2px 9px; }
  .tab:disabled { cursor: not-allowed; }
  .synth { display: flex; flex: 1; min-height: 0; min-width: 0; }
  .editor { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
  .body { padding: 8px; overflow: auto; flex: 1; display: flex; flex-direction: column; min-height: 0; }
  /* Banners: a recessed --well strip with a coloured edge: --rec for errors,
     --accent for notes and questions. The text stays --text (readable on the
     well); the edge and the primary button carry the colour. */
  .banner {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 6px;
    border-radius: var(--r-md); background: var(--well); box-shadow: var(--well-shadow), inset 3px 0 0 var(--bc); color: var(--text);
  }
  .banner button { font: inherit; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; font-size: 14px; }
  .banner button:hover { color: var(--text); }
  .banner[data-testid='ask'] span { flex: 1; }
  .banner[data-testid='ask'] button, .banner .cancel {
    font: 500 var(--fs-ctl)/16px var(--font-ui); padding: 2px 10px; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text);
  }
  .banner progress { flex: 1; height: 8px; accent-color: var(--accent); }
  .banner a { color: var(--accent); font-weight: 600; }
  .banner[data-testid='ask'] .ok { background-color: var(--accent); color: var(--on-color); font-weight: 700; }
  .err { --bc: var(--rec); }
  .note { --bc: var(--accent); }
</style>
