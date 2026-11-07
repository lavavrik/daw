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
  //   waveform  above the controls, full width, 120 px (ui/vis/WaveformView,
  //             plan 12): x = clip time 0..len with a beat grid; the file as
  //             the clip plays it (offset, loop) drawn pre-gain, the gain ×
  //             fades envelope as a line over it, loop seams dashed, and the
  //             playhead while the song playhead is inside the clip. Zooms
  //             down to single samples. Display only: editing stays in the
  //             fields (drag handles are a follow-up).
  //
  // Every change goes through state/audio-actions.ts setAudioClip (one
  // undoable edit; SOURCE, GAIN, SET to the engine).
  // Test ids start with `cliptab-`, never `clip-` (that prefix is the
  // timeline's clips: tests count `[data-testid^="clip-"]`).
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import { fineRequestFor } from '../audio/fineSamples';
  import type { AudioClip, AudioTrack, Project } from '../state/project.svelte';
  import { CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, setAudioClip, ticksPerSecond } from '../state/audio-actions';
  import WaveformView from './vis/WaveformView.svelte';
  import { clipEnvelope, clipMap, seamFrames, waveBase } from './vis/waveMath';
  import type { WaveOverlay } from './vis/waveMath';
  import { clipFocus, sampleName } from './song/clipFocus.svelte';
  import { banners } from '../state/banners.svelte';
  import { pendingSampleIds, sampleFailed } from '../state/sampleLoads';

  let { p, engine, clock = null, track }: {
    p: Project;
    engine: AudioEngine;
    clock?: AudioClock | null;
    track: AudioTrack;
  } = $props();

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

  // ---- waveform ---------------------------------------------------------
  /** The sample's axis (peaks' rate) and the clip's map onto it; null without a known sample. */
  const wave = $derived.by(() => {
    if (!clip || !meta) return null;
    const base = waveBase(meta, engine.sampleRate);
    return { base, map: clipMap(clip, p.tempo, base.rate, base.frames) };
  });
  /** Sample-level data: the kept bytes, decoded with the engine's context (its rate is in the key). */
  const fine = $derived.by(() => {
    void p.peaksVersion;
    const id = clip?.sampleId ?? null;
    const f = id !== null ? p.sampleFiles.get(id) : undefined;
    return f && meta ? fineRequestFor(f, meta, engine.context) : null;
  });
  const overlayKey = $derived(clip ? [clip.gain, clip.fadeIn, clip.fadeOut, clip.len, clip.offset, clip.loop, p.tempo].join('|') : '');

  /** Beat grid (bars brighter), loop seams (dashed) and the gain × fades envelope, in CSS px. */
  function drawOverlay(ctx: CanvasRenderingContext2D, o: WaveOverlay) {
    const c = clip;
    const w = wave;
    if (!c || !w) return;
    const fpt = w.base.rate / ticksPerSecond(p.tempo); // view frames per tick
    const f0 = o.view.frame0;
    const f1 = f0 + o.width * o.view.framesPerPx;
    const beatF = BEAT * fpt;
    const step = beatF / o.view.framesPerPx >= 4 ? 1 : (4 * beatF) / o.view.framesPerPx >= 4 ? 4 : 0;
    if (step) {
      for (let k = Math.ceil(f0 / beatF / step) * step; k * beatF <= f1; k += step) {
        ctx.fillStyle = k % 4 === 0 ? '#ffffff2e' : '#ffffff12';
        ctx.fillRect(Math.round(o.x(k * beatF)), 0, 1, o.height);
      }
    }
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#c9cbd3a0';
    ctx.lineWidth = 1;
    for (const f of seamFrames(w.map, f0, f1)) {
      const x = Math.round(o.x(f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, o.height);
      ctx.stroke();
    }
    ctx.restore();
    // The envelope: lane edge = 1 (0 dB); louder gains sit at the edge.
    const env = clipEnvelope(c);
    const laneH = o.height / o.lanes;
    ctx.strokeStyle = '#ffd98a';
    ctx.lineWidth = 1.5;
    for (let l = 0; l < o.lanes; l++) {
      const mid = l * laneH + laneH / 2;
      const amp = laneH / 2 - 1;
      ctx.beginPath();
      env.points.forEach(([t, v], i) => {
        const x = o.x(t * fpt);
        const y = mid - Math.min(1, v) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  /** The heard song position as a view frame while it is inside the clip (Song mode, playing). */
  function playhead(): number | null {
    const c = clip;
    const w = wave;
    if (!c || !w || !clock || !p.playing || p.mode !== 'song') return null;
    const t = clock.heardTicks();
    if (!(t >= c.start && t < c.start + c.len)) return null;
    return ((t - c.start) / ticksPerSecond(p.tempo)) * w.base.rate;
  }

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
    {#if wave}
      {#key c.id}
        <WaveformView
          base={wave.base} map={wave.map} {fine} height={120} color={track.color}
          testid="cliptab-wave" label="Waveform of {name}"
          overlay={drawOverlay} {overlayKey} {playhead} live={p.playing && p.mode === 'song'}
        />
      {/key}
    {/if}
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
