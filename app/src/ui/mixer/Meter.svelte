<script lang="ts">
  // Stereo peak meter for one mixer channel (L and R bars), on the same dB
  // scale as the fader beside it (mixMath.meterPos uses the fader law, so the
  // ticks line up). Each bar shows the published peak (worklet ballistics:
  // instant attack, 60 dB/s fall; see audio/meterBallistics.ts) and a
  // peak-hold line that stays at the highest peak for 1 s (holdStep).
  //
  // Clip light: lights when a peak reaches the ceiling (0 dBFS on strips, the
  // limiter ceiling on the master) and stays lit until clicked, so a single
  // over is never missed.
  //
  // Updated from the mixer's single rAF loop (MeterBus) by writing styles
  // directly; data-peak-db / data-hold-db expose the values to tests.
  import { MIX_METER_STRIDE } from '../../audio/protocol';
  import type { MeterBus } from './meterBus';
  import { holdStep, isClip, linToDb, meterPos } from './mixMath';
  import type { Hold } from './mixMath';

  let { bus, channel, ceilingDb = 0, name }: {
    bus: MeterBus;
    /** Mixer channel index (0..31 track slot, MIX_REVERB/DELAY/MASTER). */
    channel: number;
    /** Clip threshold, dBFS. */
    ceilingDb?: number;
    /** For the accessible name ("Drums meter"). */
    name: string;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  const covers: (HTMLElement | null)[] = $state([null, null]);
  const holdEls: (HTMLElement | null)[] = $state([null, null]);
  let clipped = $state(false);
  const holds: Hold[] = [{ db: -Infinity, t: 0 }, { db: -Infinity, t: 0 }];
  const shownPos = [-1, -1];
  const shownHold = [-1, -1];

  // Subscribed for the component's life (re-subscribes if the bus changes).
  $effect(() => bus.on((m, now) => {
    const base = channel * MIX_METER_STRIDE;
    let peakDb = -Infinity;
    for (let c = 0; c < 2; c++) {
      const lin = m[base + c] ?? 0;
      const db = linToDb(lin);
      if (db > peakDb) peakDb = db;
      const pos = meterPos(lin);
      // Only touch the DOM when the bar moved by at least 0.1% of its height.
      if (Math.abs(pos - shownPos[c]) > 0.001) {
        shownPos[c] = pos;
        const el = covers[c];
        if (el) el.style.height = `${((1 - pos) * 100).toFixed(2)}%`;
      }
      holds[c] = holdStep(holds[c], db, now);
      const hp = meterPos(10 ** (holds[c].db / 20));
      if (hp !== shownHold[c]) {
        shownHold[c] = hp;
        const el = holdEls[c];
        if (el) {
          el.style.bottom = `${(hp * 100).toFixed(2)}%`;
          el.style.visibility = hp > 0 ? 'visible' : 'hidden';
        }
      }
      if (!clipped && isClip(lin, ceilingDb)) clipped = true;
    }
    if (root) {
      const r = (x: number) => (x > -200 ? x.toFixed(1) : '-inf');
      root.dataset.peakDb = r(peakDb);
      root.dataset.holdDb = r(Math.max(holds[0].db, holds[1].db));
    }
  }));
</script>

<div class="meter" bind:this={root} data-testid="meter" data-peak-db="-inf" data-hold-db="-inf" role="img" aria-label={`${name} meter, peak hold 1 s`}>
  <button
    type="button"
    class="clip"
    class:on={clipped}
    data-testid="clip"
    aria-label={clipped ? `${name} clipped — reset` : `${name} clip light (off)`}
    title={clipped ? `Clipped: a peak reached ${ceilingDb === 0 ? '0 dBFS' : `the ${ceilingDb.toFixed(1)} dB ceiling`}. Click to reset.` : 'Clip light: lights when a peak reaches the ceiling'}
    onclick={() => (clipped = false)}
  ></button>
  <div class="bars">
    {#each [0, 1] as c (c)}
      <div class="bar" title={c === 0 ? 'Left' : 'Right'}>
        <div class="cover" bind:this={covers[c]}></div>
        <div class="hold" bind:this={holdEls[c]}></div>
      </div>
    {/each}
  </div>
</div>

<style>
  /* Clip light (6px) + gap (3px) = the fader's 9px top margin, so the bars
     span exactly the scale beside them (bottom margin set by the parent). */
  .meter { display: flex; flex-direction: column; align-items: stretch; gap: 3px; height: 100%; width: 14px; box-sizing: border-box; }
  .clip { height: 6px; flex: none; padding: 0; border: 0; border-radius: 2px; background: #3a2226; cursor: pointer; }
  .clip.on { background: #ff3b47; box-shadow: 0 0 4px #ff3b47; }
  .bars { flex: 1; display: flex; gap: 2px; min-height: 0; }
  .bar {
    position: relative; flex: 1; overflow: hidden; border-radius: 1px;
    /* Static scale colours; the cover hides everything above the level.
       Stops follow the fader law: 0.75 = 0 dBFS, 0.63 ≈ −6 dBFS. */
    background: linear-gradient(to top, #2fbf71 0%, #2fbf71 60%, #e4c23a 66%, #f08a3a 74%, #ff3b47 76%, #ff3b47 100%);
  }
  .cover { position: absolute; left: 0; right: 0; top: 0; height: 100%; background: #121317; }
  .hold { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; margin-bottom: -1px; background: #f2f3f7; visibility: hidden; }
</style>
