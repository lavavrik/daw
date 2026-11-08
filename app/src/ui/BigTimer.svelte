<script lang="ts">
  // The top bar's big timer (spec §4): bar:beat:tick of the SONG position in
  // JetBrains Mono at 32 px, with the time in seconds under the
  // "Bar · Beat · Tick" label. The maths is bigTimer.ts.
  //
  // What it shows:
  //   - the song transport plays: the heard position (AudioClock.heardTicks,
  //     what is coming out of the speakers, as the timeline's playhead),
  //     read once per animation frame. The rAF loop runs only then;
  //   - otherwise (stopped, or the PATTERN transport plays): the parked song
  //     position (project.songPosition: where song Play starts). The pattern's
  //     own position is the bottom panel's readout (PatternTransport).
  // Stopped at the start it reads 1:01:000.
  //
  // aria-live="off": a per-frame number must never be announced; the
  // role="timer" region has a name, so a screen reader can read it on demand.
  import type { AudioClock } from '../audio/audioClock';
  import type { Project } from '../state/project.svelte';
  import { timerParts, timerSeconds } from './bigTimer';

  let { p, clock }: { p: Project; clock: AudioClock | null } = $props();

  /** The heard tick while the song plays (per frame), else null. */
  let heard = $state<number | null>(null);
  $effect(() => {
    if (!p.playing || p.mode !== 'song' || !clock) return;
    const c = clock;
    let raf = 0;
    const loop = () => {
      const t = c.heardTicks();
      heard = Number.isFinite(t) ? Math.max(0, Math.floor(t)) : null;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      heard = null;
    };
  });

  const ticks = $derived(heard ?? p.songPosition);
  const parts = $derived(timerParts(ticks));
  const secs = $derived(timerSeconds(ticks, p.tempo));
</script>

<div class="timer" data-testid="timer" role="timer" aria-live="off" aria-label="Song position" title="Song position: bar : beat : tick, and the time">
  <span class="pos" data-testid="timer-pos">{parts.bar}<i>:</i>{parts.beat}<i>:</i><small>{parts.tick}</small></span>
  <span class="side">
    <span class="lbl">Bar · Beat · Tick</span>
    <span class="secs" data-testid="timer-seconds">{secs}</span>
  </span>
</div>

<style>
  /* An --lcd well, 48 px tall (spec §4 / the canvas). The position is
     right-aligned in a box wide enough for the longest one, "999:04:959"
     (MAX_SONG_TICKS: 999 bars): 7 digits at 32 px and 3 at 22 px, each
     0.6em minus the 0.02em letter-spacing. So nothing moves while the song
     plays, also past bar 99. */
  .timer {
    flex: none; display: flex; align-items: center; gap: 8px; height: 48px; box-sizing: border-box; padding: 0 10px;
    border-radius: var(--r-lg); background: var(--lcd); box-shadow: var(--well-shadow); cursor: default;
  }
  /* Short windows (< 740 px tall): the top bar is 40 px (TopBar.svelte). */
  @media (max-height: 739px) { .timer { height: 36px; border-radius: var(--r-md); } }
  .pos {
    min-width: calc(7 * 0.58 * 32px + 3 * 0.58 * 22px); text-align: right; white-space: nowrap;
    font: 700 32px/1 var(--font-mono); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--text);
  }
  .pos i { font-style: normal; color: var(--accent); }
  .pos small { font-size: 22px; color: var(--text-2); }
  .side { display: flex; flex-direction: column; gap: 2px; }
  .lbl { font-size: 9px; color: var(--text-dim); white-space: nowrap; }
  .secs { font: 500 11px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-2); }
</style>
