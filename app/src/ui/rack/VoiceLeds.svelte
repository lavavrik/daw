<script lang="ts">
  // Voice-activity LEDs (plan 12 Task 5; docs/architecture/modular.md
  // "Polyphony", visuals.md "Voice LEDs"), in the Instrument tab's header
  // after the patch dropdown.
  //
  // - "Voices" and N LEDs, N = the first MIDI In's `voices` (lowest module
  //   idx: the one the engine reports gates for), 1 in Mono. A rack without
  //   a MIDI In shows nothing and wants nothing.
  // - Per voice k of this track's engine slot, visSab voices holds the
  //   level (the max |sample| of the voice across the rack's Outs, with
  //   the meters' ballistics; 0 below −60 dB) and the MIDI In's gate
  //   (worklet visCopy.ts, want bit 4). Brightness = voiceLedLevel
  //   (−48..0 dB → 0..1); a ring = the gate is held.
  // - A 30 Hz frame-loop consumer (ui/vis/frameLoop.ts) that writes the
  //   LEDs' style directly, only when a value changed (the MeterBus rule).
  import { VIS_WANT, type VisViews } from '../../audio/visLayout';
  import { moduleDef } from '../../audio/catalog';
  import { MAX_POLY } from '../../audio/protocol';
  import type { SynthTrack } from '../../state/project.svelte';
  import { frameLoop } from '../vis/frameLoop';
  import { voiceLedLevel } from '../vis/shapes';

  let { track }: { track: SynthTrack } = $props();

  const MIDI_IN = moduleDef('midi_in');
  const VOICES = MIDI_IN.params.findIndex((p) => p.name === 'voices');
  const MODE = MIDI_IN.params.findIndex((p) => p.name === 'mode');

  /** LEDs shown: the first MIDI In's voice count (1 in Mono), 0 without a MIDI In. */
  const count = $derived.by(() => {
    let first: (typeof track.modules)[number] | null = null;
    for (const m of track.modules) if (m.kind === MIDI_IN.kind && (!first || m.idx < first.idx)) first = m;
    if (!first) return 0;
    if ((first.params[MODE] ?? 0) >= 0.5) return 1;
    return Math.max(1, Math.min(MAX_POLY, Math.round(first.params[VOICES] ?? MIDI_IN.params[VOICES].default)));
  });

  let box = $state<HTMLElement | null>(null);
  const leds: HTMLElement[] = [];
  /** What each LED shows now (brightness, gate), to write only on change. */
  const shown = new Float32Array(MAX_POLY * 2).fill(-1);

  function frame(_now: number, vis: VisViews) {
    const base = track.slot * MAX_POLY * 2;
    const v = vis.voices;
    for (let k = 0; k < count; k++) {
      const el = leds[k];
      if (!el) continue;
      const lv = voiceLedLevel(v[base + k * 2]);
      const g = v[base + k * 2 + 1] >= 0.5 ? 1 : 0;
      // Quantised to 1/64: no style write for an invisible change.
      const q = Math.round(lv * 64) / 64;
      if (q !== shown[k * 2]) {
        shown[k * 2] = q;
        el.style.setProperty('--lv', String(q));
        el.dataset.on = q > 0 ? '1' : '0';
      }
      if (g !== shown[k * 2 + 1]) {
        shown[k * 2 + 1] = g;
        el.dataset.gate = String(g);
      }
    }
  }

  $effect(() => {
    if (!box || count === 0) return;
    shown.fill(-1);
    return frameLoop().add({ want: VIS_WANT.voices, el: box, hz: 30, frame });
  });
</script>

{#if count > 0}
  <span class="voices" bind:this={box} data-testid="voice-leds" role="img" aria-label={`${count} voice${count === 1 ? '' : 's'} activity`}>
    <span class="lbl">Voices</span>
    {#each Array.from({ length: count }, (_, k) => k) as k (k)}
      <i bind:this={leds[k]} data-testid={`voice-led-${k}`} data-on="0" data-gate="0"></i>
    {/each}
  </span>
{/if}

<style>
  .voices { display: flex; align-items: center; gap: 3px; color: #8d90a0; font-size: 11px; }
  .lbl { margin-right: 2px; }
  i {
    --lv: 0;
    width: 7px; height: 7px; border-radius: 50%; box-sizing: border-box;
    background: color-mix(in srgb, #7dff9a calc(var(--lv) * 100%), #23262d);
    box-shadow: 0 0 calc(var(--lv) * 5px) color-mix(in srgb, #7dff9a calc(var(--lv) * 70%), transparent);
    border: 1px solid #3a3d48;
  }
  /* data-gate is written by frame(), not the template */
  .voices > :global(i[data-gate='1']) { border-color: #f0a23a; }
</style>
