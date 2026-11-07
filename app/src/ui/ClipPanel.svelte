<script lang="ts">
  // The bottom panel's Clip tab (plan 9; Alt+5): the audio clip the timeline
  // last focused (song/clipFocus.svelte.ts) on the selected Audio track.
  //
  //   info      sample name, the clip's length (bars/beats), the file's
  //             length (seconds) and channels; "missing sample" when gone
  //   Gain      a fader in dB, −∞ (−60) .. +12; one drag = one undo entry
  //             (a pointer gesture, history/gestures.ts). Double-click: 0 dB.
  //   Fade in / Fade out
  //             beats, typed exactly (Enter or leaving the field commits;
  //             Escape puts the shown value back). setAudioClip shortens a
  //             fade that does not fit the clip; the field then shows what
  //             it really is.
  //   Loop to fill
  //             a toggle: the file repeats until the clip ends.
  //
  // Every change goes through state/audio-actions.ts setAudioClip (one
  // undoable edit; SOURCE, GAIN, SET to the engine).
  // Test ids start with `cliptab-`, never `clip-` (that prefix is the
  // timeline's clips: tests count `[data-testid^="clip-"]`).
  import type { CommandSink } from '../state/actions';
  import type { AudioClip, AudioTrack, Project } from '../state/project.svelte';
  import { CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, fileSeconds, setAudioClip } from '../state/audio-actions';
  import { clipFocus, sampleName } from './song/clipFocus.svelte';
  import { banners } from '../state/banners.svelte';
  import { pendingSampleIds, sampleFailed } from '../state/sampleLoads';

  let { p, engine, track }: { p: Project; engine: CommandSink; track: AudioTrack } = $props();

  const BEAT = 960;
  const clip = $derived<AudioClip | null>(track.clips.find((c) => c.id === clipFocus.id) ?? null);
  const name = $derived(clip ? sampleName(p, clip.sampleId) : '');
  const meta = $derived.by(() => {
    void p.peaksVersion; // sampleMeta is a plain Map: re-read when it changes
    return clip && clip.sampleId !== null ? (p.sampleMeta.get(clip.sampleId) ?? null) : null;
  });
  /** Its deferred load failed, or still waits for Stop (both settle with a peaksVersion / notice change). */
  const loadState = $derived.by(() => {
    void p.peaksVersion;
    void banners.notice;
    const id = clip?.sampleId ?? null;
    if (id === null) return null;
    return sampleFailed(id) ? 'failed' : pendingSampleIds().includes(id) ? 'pending' : null;
  });
  const gainId = $props.id();

  /** "−6.0 dB", "+3.5 dB", "−∞ dB" (the minimum is silence). */
  function gainText(db: number) {
    if (db <= CLIP_GAIN_MIN_DB) return '−∞ dB';
    const s = Math.abs(db).toFixed(1);
    return `${db < 0 && s !== '0.0' ? '−' : db > 0 && s !== '0.0' ? '+' : ''}${s} dB`;
  }
  /** Ticks -> beats as typed (up to 3 decimals, no trailing zeros). */
  const beats = (ticks: number) => String(Math.round((ticks / BEAT) * 1000) / 1000);
  /** "2 bars 1 beat" (4/4). */
  function barsBeats(ticks: number) {
    const b = ticks / BEAT;
    const bars = Math.floor(b / 4);
    const rest = Math.round((b - bars * 4) * 100) / 100;
    const parts = [];
    if (bars) parts.push(`${bars} bar${bars === 1 ? '' : 's'}`);
    if (rest || !bars) parts.push(`${rest} beat${rest === 1 ? '' : 's'}`);
    return parts.join(' ');
  }
  const chText = (n: number) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`);

  function setGain(e: Event) {
    if (!clip) return;
    setAudioClip(p, engine, clip.id, { gain: (e.currentTarget as HTMLInputElement).valueAsNumber });
  }
  /** Commit a typed fade (beats); an unreadable entry just shows the value again. */
  function setFade(which: 'fadeIn' | 'fadeOut', el: HTMLInputElement) {
    if (!clip) return;
    const v = Number(el.value);
    if (el.value.trim() !== '' && Number.isFinite(v) && v >= 0) setAudioClip(p, engine, clip.id, { [which]: Math.round(v * BEAT) });
    el.value = beats(clip[which]); // what it really is now (shortened to fit, or unchanged)
  }
  function fadeKey(e: KeyboardEvent, which: 'fadeIn' | 'fadeOut') {
    const el = e.currentTarget as HTMLInputElement;
    if (e.key === 'Enter') {
      e.preventDefault();
      setFade(which, el);
    } else if (e.key === 'Escape' && clip) {
      e.preventDefault();
      el.value = beats(clip[which]);
      el.blur();
    }
  }
</script>

<div class="cp" data-testid="cliptab-panel" style:--c={track.color}>
  {#if !clip}
    <p class="empty" data-testid="cliptab-empty">
      {track.clips.length ? `Click a clip on the ${track.name} lane to edit it here.` : `Drop audio files on the ${track.name} lane (from Finder, the library or the starter kit).`}
    </p>
  {:else}
    {@const c = clip}
    <div class="info" data-testid="cliptab-info">
      <b class:missing={c.sampleId === null || loadState === 'failed'}>{name}</b>
      {#if loadState === 'failed'}<span class="bad" data-testid="cliptab-failed">sample failed to load: it plays nothing — stop and drop it again</span>{/if}
      {#if loadState === 'pending'}<span>loads when playback stops</span>{/if}
      <span>{barsBeats(c.len)} on the timeline</span>
      {#if meta}<span>{meta.seconds.toFixed(2)} s file · {chText(meta.channels)}</span>{/if}
      {#if c.loop}<span class="tag">loops</span>{/if}
    </div>
    <div class="ctl">
      <label class="gain">
        <span class="lbl">Gain</span>
        <input
          type="range" id={gainId} data-testid="cliptab-gain" aria-label="Clip gain (dB)" aria-valuetext={gainText(c.gain)}
          min={CLIP_GAIN_MIN_DB} max={CLIP_GAIN_MAX_DB} step="0.1" value={c.gain}
          title="Clip gain: −∞ to +12 dB (double-click: 0 dB)"
          oninput={setGain}
          ondblclick={() => setAudioClip(p, engine, c.id, { gain: 0 })}
        />
        <output for={gainId} data-testid="cliptab-gain-text">{gainText(c.gain)}</output>
      </label>
      <label>
        <span class="lbl">Fade in</span>
        {#key c.id}
          <input
            type="number" data-testid="cliptab-fade-in" aria-label="Fade in (beats)" min="0" step="0.25" value={beats(c.fadeIn)}
            title="Fade in, in beats (exact: type a value, Enter)"
            onchange={(e) => setFade('fadeIn', e.currentTarget)} onkeydown={(e) => fadeKey(e, 'fadeIn')}
          />
        {/key}
        <span class="unit">beats</span>
      </label>
      <label>
        <span class="lbl">Fade out</span>
        {#key c.id}
          <input
            type="number" data-testid="cliptab-fade-out" aria-label="Fade out (beats)" min="0" step="0.25" value={beats(c.fadeOut)}
            title="Fade out, in beats (exact: type a value, Enter)"
            onchange={(e) => setFade('fadeOut', e.currentTarget)} onkeydown={(e) => fadeKey(e, 'fadeOut')}
          />
        {/key}
        <span class="unit">beats</span>
      </label>
      <label class="loop" title="Loop to fill: the file repeats until the clip ends">
        <input type="checkbox" data-testid="cliptab-loop" checked={c.loop} onchange={(e) => setAudioClip(p, engine, c.id, { loop: e.currentTarget.checked })} />
        Loop to fill
      </label>
    </div>
  {/if}
</div>

<style>
  .cp { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
  .empty { color: #8d90a0; margin: 4px 0; }
  .info { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; color: #9a9da8; }
  .info b { color: var(--c); font-size: 13px; }
  .info b.missing, .bad { color: #ff8a92; }
  .tag { font-size: 10px; border: 1px solid #3a3d48; border-radius: 3px; padding: 0 4px; color: #c9cbd3; }
  .ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; }
  label { display: flex; align-items: center; gap: 6px; color: #c9cbd3; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #7d808c; }
  .gain input { width: 180px; accent-color: var(--c); }
  output { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 58px; }
  input[type='number'] { width: 64px; font: inherit; background: #15161a; color: #e4e5ea; border: 1px solid #3a3d48; border-radius: 3px; padding: 2px 4px; }
  input[type='number']:focus-visible { outline: 2px solid #f0a23a; outline-offset: -1px; }
  .unit { color: #7d808c; font-size: 11px; }
  .loop input { accent-color: var(--c); }
</style>
