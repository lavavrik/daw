<script lang="ts">
  // The on-screen Pitch and Mod wheels: a narrow strip on the left of the
  // synth tabs (Piano roll, Acid, Instrument), like the wheels beside the
  // keys on a hardware keyboard.
  //
  // They show and drive the same two values the hardware wheels do
  // (input/wheels.svelte.ts): a keyboard's pitch wheel or mod wheel (CC 1)
  // moves them, and dragging one sends PITCH_BEND / MOD_WHEEL exactly as the
  // hardware would. The engine applies both to the live input track (the
  // selected synth track), through its MIDI In module's `bend` / `mod`
  // outputs. Nothing here is an edit (no undo, never saved).
  //
  // Pitch springs back to the centre on release (pointer up, cancel, lost
  // capture, key up, blur); Mod stays where it is left. Double-click resets
  // either. A drag is relative (grab anywhere, the full height is the full
  // range), so grabbing does not jump the value. Keyboard: Up / Down step,
  // PageUp / PageDown step big, Home resets; the pitch wheel springs back on
  // key up. Esc, Cmd/Ctrl+Z or redo during a drag cancel it (history/gestures.ts
  // registerDragCancel): the wheel goes back to where the drag started (Pitch:
  // the centre), and the key never undoes an older edit.
  import type { AudioEngine } from '../audio/engine';
  import { moduleDef, paramIndex } from '../audio/catalog';
  import { onDestroy } from 'svelte';
  import { Op } from '../audio/protocol';
  import { registerDragCancel } from '../history/gestures';
  import type { SynthTrack } from '../state/project.svelte';
  import { bendLabel, modLabel, wheels } from '../input/wheels.svelte';

  let { engine, track }: { engine: AudioEngine; track: SynthTrack } = $props();

  const MIDI_IN = moduleDef('midi_in');
  const P_BEND = paramIndex(MIDI_IN, 'bend');
  /** The patch's bend range in semitones, or null with no MIDI In. */
  const range = $derived.by(() => {
    const m = track.modules.find((x) => x.kind === MIDI_IN.kind);
    return m ? m.params[P_BEND] : null;
  });

  /** Track height in px: the full drag range. */
  const H = 104;

  type Kind = 'pitch' | 'mod';
  const lo = (k: Kind) => (k === 'pitch' ? -1 : 0);
  const value = (k: Kind) => (k === 'pitch' ? wheels.bend : wheels.mod);
  function send(k: Kind, v: number) {
    const c = Math.min(1, Math.max(lo(k), v));
    // The engine's onCommand hook moves `wheels` (the single source of truth).
    engine.send(k === 'pitch' ? Op.PITCH_BEND : Op.MOD_WHEEL, c);
  }
  /** Pitch at rest: centre. Only sends when off-centre (a hardware wheel sends one 0 too). */
  function release(k: Kind) {
    if (k === 'pitch' && wheels.bend !== 0) send('pitch', 0);
  }

  let drag: { k: Kind; y0: number; v0: number; id: number } | null = null;
  function down(k: Kind, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { k, y0: e.clientY, v0: value(k), id: e.pointerId };
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const span = 1 - lo(drag.k); // pitch 2, mod 1
    send(drag.k, drag.v0 + ((drag.y0 - e.clientY) / H) * span);
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const k = drag.k;
    drag = null;
    release(k);
  }

  /** Cancel an open drag: back to the value it started from (Pitch: the centre). */
  function cancel(): boolean {
    if (!drag) return false;
    const { k, v0 } = drag;
    drag = null;
    send(k, k === 'pitch' ? 0 : v0);
    return true;
  }
  onDestroy(registerDragCancel(cancel));

  function key(k: Kind, e: KeyboardEvent) {
    if (e.key === 'Escape' && cancel()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const step = e.key === 'PageUp' || e.key === 'PageDown' ? 0.25 : 0.05;
    let v: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp') v = value(k) + step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown') v = value(k) - step;
    else if (e.key === 'Home') v = 0;
    if (v === null) return;
    // Keep these keys away from the global shortcuts and the QWERTY piano.
    e.preventDefault();
    e.stopPropagation();
    send(k, v);
  }
  function keyUp(k: Kind, e: KeyboardEvent) {
    if (/^(Arrow|Page)/.test(e.key)) release(k);
  }

  /** Thumb position: 0 at the bottom, 1 at the top. */
  const pos = (k: Kind) => (value(k) - lo(k)) / (1 - lo(k));
</script>

<div class="wheels" data-testid="wheels">
  {#each ['pitch', 'mod'] as const as k (k)}
    {@const v = value(k)}
    <div class="wheel">
      <span class="name">{k === 'pitch' ? 'Pitch' : 'Mod'}</span>
      <div
        class="track"
        class:pitch={k === 'pitch'}
        style:height="{H}px"
        role="slider"
        tabindex="0"
        aria-label={k === 'pitch' ? 'Pitch wheel' : 'Mod wheel'}
        aria-orientation="vertical"
        aria-valuemin={lo(k)}
        aria-valuemax={1}
        aria-valuenow={Math.round(v * 1000) / 1000}
        aria-valuetext={k === 'pitch' ? bendLabel(v, range) : modLabel(v)}
        title={k === 'pitch'
          ? 'Pitch wheel: drag up or down, springs back to the centre (follows your keyboard’s pitch wheel)'
          : 'Mod wheel: drag up or down, stays where you leave it (follows your keyboard’s mod wheel, CC 1). Double-click resets.'}
        data-testid="wheel-{k}"
        onpointerdown={(e) => down(k, e)}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
        onlostpointercapture={up}
        ondblclick={() => send(k, 0)}
        onkeydown={(e) => key(k, e)}
        onkeyup={(e) => keyUp(k, e)}
        onblur={() => release(k)}
      >
        {#if k === 'pitch'}<i class="centre"></i>{/if}
        <i class="fill" style:bottom="{k === 'pitch' ? Math.min(pos(k), 0.5) * 100 : 0}%" style:top="{(1 - (k === 'pitch' ? Math.max(pos(k), 0.5) : pos(k))) * 100}%"></i>
        <i class="thumb" style:bottom="calc({pos(k) * 100}% - 3px)"></i>
      </div>
      <span class="val" data-testid="wheel-{k}-value">{k === 'pitch' ? bendLabel(v, range) : modLabel(v)}</span>
    </div>
  {/each}
</div>

<style>
  .wheels { flex: none; display: flex; gap: 6px; padding: 2px 8px 2px 0; margin-right: 8px; border-right: 1px solid #2a2c33; align-self: flex-start; }
  .wheel { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 34px; }
  .name, .val { font-size: 10px; color: #9a9dab; white-space: nowrap; }
  .val { color: #c9cbd3; font-variant-numeric: tabular-nums; }
  .track { position: relative; width: 20px; background: #15161a; border: 1px solid #3a3d48; border-radius: 4px; cursor: ns-resize; touch-action: none; overflow: hidden; }
  .track:focus-visible { outline: 2px solid #f0a23a; outline-offset: 1px; }
  .track i { position: absolute; left: 0; right: 0; display: block; pointer-events: none; }
  .centre { top: 50%; height: 1px; background: #4a4e5b; }
  .fill { background: color-mix(in srgb, #f0a23a 30%, transparent); }
  .thumb { height: 6px; background: #f0a23a; border-radius: 2px; }
</style>
