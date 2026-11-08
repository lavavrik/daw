<script lang="ts">
  // The pattern transport (plan 20, spec §4), in the bottom panel's header:
  // Play / Stop for Pattern mode (the shown track loops its current pattern;
  // the other tracks are silent: SET_PATTERN_FOCUS, plan 20 task 12), the
  // record arm and Count-in (recording only works in Pattern mode, so they
  // live here), and the readout of where the selected track's current pattern
  // is ("1.3 / 2" = bar 1, beat 3 of 2 bars; "– / 2" while it is not
  // playing; ui/patternReadout.ts).
  //
  // Starting it stops the song transport first (state/song-actions.ts
  // playPattern); the App owns the transport calls so the recorder's count-in
  // and stop tick are handled in one place (onPlay / onStop / onToggleArm).
  // Space plays / stops it while focus is inside the bottom panel
  // (input/shortcuts.ts).
  //
  // With no track or an Audio track selected (no pattern) the transport is
  // disabled with a tooltip saying why, except that a running pattern can
  // still be stopped and an armed Rec disarmed. Otherwise Stop is enabled
  // even when nothing plays (a no-op then), so the idle transport reads as
  // ready, not as disabled.
  //
  // Look (owner: idle must not look disabled; same language as the top
  // bar's song transport): idle = a normal raised button (--raised, gloss,
  // raised shadow), Play's icon a light --play green, Stop's --text;
  // playing = Play filled --play with an --on-color icon and a glow;
  // disabled (no pattern track) = flat (no gloss, no shadow), 40% opacity,
  // a not-allowed cursor.
  //
  // Rec: "Rec" with a red LED arms (R key); red while armed, "Count-in…"
  // during the count-in, "REC" (pulsing) while notes are being recorded. While the
  // song plays it can't arm (Song mode never records). Count-in persists in
  // localStorage (state/recorder.ts saveRecSettings), with the Rec offset
  // that stays in the top bar.
  import { untrack } from 'svelte';
  import type { AudioClock } from '../audio/audioClock';
  import { patternLength, currentPattern } from '../state/project.svelte';
  import type { PatternTrack, Project } from '../state/project.svelte';
  import { transportPlaying } from '../state/song-actions';
  import Icon from './Icon.svelte';
  import Play from 'phosphor-svelte/lib/Play';
  import Stop from 'phosphor-svelte/lib/Stop';
  import { saveRecSettings } from '../state/recorder';
  import type { Recorder, RecStatus } from '../state/recorder';
  import { noPatternReason, patternReadout } from './patternReadout';

  let { p, track, audio = false, clock, recorder, rec, onPlay, onStop, onToggleArm }: {
    p: Project;
    /** The selected track when it plays patterns; null for none or an Audio track. */
    track: PatternTrack | null;
    /** The selected track is an Audio track (only changes the tooltip). */
    audio?: boolean;
    clock: AudioClock | null;
    recorder: Recorder;
    /** Recorder status, refreshed every frame by the App. */
    rec: RecStatus;
    onPlay: () => void;
    onStop: () => void;
    onToggleArm: () => void;
  } = $props();

  const playing = $derived(transportPlaying(p, 'pattern'));
  const songPlaying = $derived(transportPlaying(p, 'song'));
  const why = $derived(noPatternReason(track ? track.kind : audio ? 'audio' : null));
  const len = $derived(track ? patternLength(currentPattern(track)) : 0);

  // The readout: from the heard tick, at most once per animation frame, and
  // only while the pattern transport runs (state is set only when the text
  // changes, i.e. on each beat).
  let live = $state<string | null>(null);
  const readout = $derived(track ? (live ?? patternReadout(null, len)) : '– / –');
  $effect(() => {
    live = null;
    if (!playing || !clock || !track) return;
    const c = clock;
    const l = len;
    let raf = 0;
    const loop = () => {
      const next = patternReadout(c.heardTicks(), l);
      if (next !== live) live = next;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  // Mirror of the recorder's persisted Count-in (the Recorder is not
  // reactive). Seeded once on purpose: the recorder lives for the session and
  // this toggle is its only writer.
  let countIn = $state(untrack(() => recorder.countIn));
  function toggleCountIn() {
    recorder.countIn = countIn = !countIn;
    saveRecSettings({ countIn: recorder.countIn, offsetMs: recorder.offsetMs });
  }
  const recLabel = $derived(rec.state === 'count-in' ? 'Count-in…' : rec.state === 'recording' ? 'REC' : 'Rec');
  const recTitle = $derived(
    songPlaying && !rec.armed ? 'Recording works with the pattern transport: stop the song first'
    : why && !rec.armed ? why
    : 'Record arm (R). Records into the Keys → track\'s current pattern while the pattern plays.',
  );
</script>

<div class="pt well" role="group" aria-label="Pattern transport" title={why ?? undefined}>
  <button
    class="b play" class:on={playing} aria-pressed={playing} data-testid="pattern-play" disabled={!!why}
    aria-label="Play pattern" title={why ?? 'Play the patterns on a loop (Space while the panel has focus)'} onclick={onPlay}
  ><Icon icon={Play} size={12} weight="fill" /></button>
  <button
    class="b" data-testid="pattern-stop" disabled={!playing && !!why}
    aria-label="Stop pattern" title="Stop the pattern (Space while the panel has focus)" onclick={onStop}
  ><Icon icon={Stop} size={12} weight="fill" /></button>
  <button
    class="b rec" class:armed={rec.armed} class:live={rec.state === 'recording'}
    aria-pressed={rec.armed} data-testid="rec-button" data-state={rec.state}
    disabled={!rec.armed && (songPlaying || !!why)} title={recTitle} onclick={onToggleArm}
  >{#if rec.state !== 'count-in'}<span class="led" aria-hidden="true"></span>{/if}{recLabel}</button>
  <!-- Rec and Count-in keep the test ids they had in the top bar (rec-button, count-in). -->
  <button
    class="b ci" class:on={countIn} aria-pressed={countIn} data-testid="count-in" disabled={!!why} aria-label="Count-in"
    title={why ?? 'Count-in: one bar of metronome before recording starts (when armed)'} onclick={toggleCountIn}
  >1-2</button>
  <span class="pos mono" data-testid="pattern-pos" aria-label="Position in the pattern (bar.beat / bars)">{readout}</span>
</div>

<style>
  /* 22 px tall, like the picker beside it: a taller header would cost the
     editors below a row at 1280×720 (pianoroll.spec layout test). */
  .pt { display: inline-flex; align-items: center; gap: 3px; padding: 1px; flex: none; }
  .b {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 28px; height: 20px; padding: 0 6px; border: 0; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--text); font: 700 11px/1 var(--font-ui); white-space: nowrap; cursor: pointer;
  }
  .b:hover:not(:disabled) { filter: brightness(1.08); }
  .b:disabled { opacity: 0.4; background: var(--raised); box-shadow: none; cursor: not-allowed; }
  .b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* Contrast (WCAG: 3:1 for icons, 4.5:1 for text): --play, --rec and
     --accent as text or icons on --raised fail (1.7-2.8:1). Play idle: a
     light green icon (--play mixed with --text, 3.3:1 on --raised); playing
     the vivid --play fill with an --on-color icon (9.6:1) and a glow. Rec: a
     --rec LED (an --on-color ring keeps it 3:1 from the button) beside a
     --text label; armed the vivid --rec fill with --on-color text (5.6:1). */
  .play { color: color-mix(in srgb, var(--play) 55%, var(--text)); }
  .play.on { background: var(--play) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--play) 40%, transparent); }
  .rec { min-width: 66px; gap: 5px; }
  .led { width: 7px; height: 7px; border-radius: 50%; background: var(--rec); box-shadow: 0 0 0 1.5px var(--on-color); }
  .rec.armed { background: var(--rec) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--rec) 40%, transparent); }
  .rec.armed .led { background: var(--on-color); box-shadow: none; }
  .rec.live { animation: rec-pulse 1s ease-in-out infinite; }
  @keyframes rec-pulse { 50% { filter: brightness(0.7); } }
  .ci.on { background: var(--accent) var(--gloss); color: var(--on-color); }
  /* Fixed width: the readout changing never moves the picker beside it. */
  .pos { min-width: 7ch; padding: 0 6px; color: var(--text-dim); font-size: 11px; text-align: center; }
</style>
