<script lang="ts">
  // The Scope module's screen (plan 12, Task 2): in its ModulePanel, above
  // the knobs. The engine records min/max entries into a scope-bank slot
  // stamped with (track slot, module idx); the worklet mirrors them into
  // visSab (want bit 8); this view finds its slot by that owner and draws
  // it on the app's one frame loop (ui/vis/frameLoop.ts), straight onto the
  // canvas, never through Svelte state (the MeterBus rule).
  //
  // - 168 × 96 css px, device-pixel sharp; a 10 × 8 grid; A orange, B cyan
  //   (B only while connected).
  // - decim 1 draws a line through the entries; a larger decim draws the
  //   min..max band (the honest envelope of a long timebase).
  // - Gain A/B scale the traces; a trace beyond the edge is clipped, with a
  //   small ▲/▼ in its colour at that edge.
  // - XY plots (A, B) mids as dots, the newest brightest (a short trail).
  // - Readout "5 ms/div" or "1/4 · sync"; tags "no trig" (Auto found no
  //   crossing: free-running) and "idle" (no new entries for 250 ms: the
  //   rack is not rendering; the last frame stays, dimmed). Both are also on
  //   the button as data-readout / data-tag (e2e).
  // - Click freezes (UI only, not saved; ❚❚). The window choice is
  //   scopeMath.ts (trigger, sync grid, readable range).
  import { onMount } from 'svelte';
  import { moduleDef } from '../../audio/catalog';
  import { SCOPE_FLAG, SCOPE_HDR, VIS_HDR, VIS_WANT, type VisViews } from '../../audio/visLayout';
  import { VIS_SCOPE_HDR, VIS_SCOPE_RING, VIS_SCOPES } from '../../audio/protocol';
  import { SIGNAL_COLORS, THEME } from '../theme';
  import { frameLoop } from '../vis/frameLoop';
  import { createIdleDriver, type IdleDriver } from '../vis/idleDriver';
  import { createSyncHold, findScope, readout, scopeWindow, windowFrames, windowLen } from '../vis/scopeMath';

  let { track, idx, params, sampleRate = 48000, tempo = 120 }: {
    /** The synth track's engine slot. */
    track: number;
    /** The Scope's module idx. */
    idx: number;
    /** Its params, catalog order (time, sync, division, gain_a, gain_b, mode, trig). */
    params: number[];
    sampleRate?: number;
    tempo?: number;
  } = $props();

  const W = 168;
  const H = 96;
  // Canvas colours from the theme (ui/theme.ts): trace A the accent, B cv blue.
  const A = THEME.accent;
  const B = SIGNAL_COLORS.cv;
  const IDLE_MS = 250;
  const MASK = VIS_SCOPE_RING - 1;
  const DIVISIONS = moduleDef('scope').params[2].choices;

  let canvas: HTMLCanvasElement;
  let box: HTMLButtonElement;
  let frozen = $state(false);

  // Views over visSab, made once per engine (subarray allocates).
  let views: VisViews | null = null;
  let hdrs: Int32Array = new Int32Array(0);
  const slotHdr: Int32Array[] = [];
  const rings: Float32Array[] = [];
  function bind(v: VisViews) {
    if (v === views) return;
    views = v;
    hdrs = v.hdr.subarray(VIS_HDR.scopes, VIS_HDR.scopes + VIS_SCOPES * VIS_SCOPE_HDR);
    for (let s = 0; s < VIS_SCOPES; s++) {
      slotHdr[s] = hdrs.subarray(s * VIS_SCOPE_HDR, (s + 1) * VIS_SCOPE_HDR);
      rings[s] = v.scopes.subarray(s * VIS_SCOPE_RING * 4, (s + 1) * VIS_SCOPE_RING * 4);
    }
  }

  // Redraw only when something changed: the head, the slot, a param, idle.
  const last = new Float64Array(12).fill(NaN);
  let lastMove = -Infinity;
  let dpr = 1;

  function changed(head: number, slot: number, idle: boolean): boolean {
    let diff = false;
    const put = (i: number, x: number) => {
      if (last[i] !== x) {
        last[i] = x;
        diff = true;
      }
    };
    put(0, head);
    put(1, slot);
    put(2, idle ? 1 : 0);
    put(3, sampleRate);
    put(4, tempo);
    for (let i = 0; i < 7; i++) put(5 + i, params[i] ?? 0);
    return diff;
  }

  function grid(c: CanvasRenderingContext2D) {
    c.fillStyle = THEME.lcd;
    c.fillRect(0, 0, W, H);
    c.lineWidth = 1;
    c.strokeStyle = THEME.text; // faint graticule: the text colour at low alpha
    c.globalAlpha = 0.07;
    c.beginPath();
    for (let i = 1; i < 10; i++) {
      const x = Math.round((i * W) / 10) + 0.5;
      c.moveTo(x, 0);
      c.lineTo(x, H);
    }
    for (let i = 1; i < 8; i++) {
      const y = Math.round((i * H) / 8) + 0.5;
      c.moveTo(0, y);
      c.lineTo(W, y);
    }
    c.stroke();
    c.globalAlpha = 0.14;
    c.beginPath();
    c.moveTo(0, H / 2 + 0.5);
    c.lineTo(W, H / 2 + 0.5);
    c.stroke();
    c.globalAlpha = 1;
  }

  /** One trace (`off` 0 = A, 2 = B) of entries `start..start+len`. */
  function trace(c: CanvasRenderingContext2D, ring: Float32Array, start: number, len: number, off: number, gain: number, color: string, line: boolean) {
    const y = (v: number) => H / 2 - v * gain * (H / 2);
    let over = false;
    let under = false;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 1.25;
    c.beginPath();
    if (line) {
      const dx = W / Math.max(1, len - 1);
      for (let i = 0; i < len; i++) {
        const v = ring[(((start + i) & MASK) << 2) + off];
        if (v * gain > 1) over = true;
        if (v * gain < -1) under = true;
        if (i === 0) c.moveTo(0, y(v));
        else c.lineTo(i * dx, y(v));
      }
      c.stroke();
    } else {
      // The band: maxes left to right, then mins back, both at entry i's x.
      const dx = W / Math.max(1, len - 1);
      for (let i = 0; i < len; i++) {
        const v = ring[(((start + i) & MASK) << 2) + off + 1];
        if (v * gain > 1) over = true;
        if (i === 0) c.moveTo(0, y(v));
        else c.lineTo(i * dx, y(v));
      }
      for (let i = len - 1; i >= 0; i--) {
        const v = ring[(((start + i) & MASK) << 2) + off];
        if (v * gain < -1) under = true;
        c.lineTo(i * dx, y(v));
      }
      c.closePath();
      c.globalAlpha *= 0.85;
      c.fill();
      c.globalAlpha /= 0.85;
      // The outline keeps a thin band (a slow wave at a small decim) visible.
      c.lineWidth = 1;
      c.stroke();
    }
    const mx = off === 0 ? W - 18 : W - 9;
    c.font = `7px ${THEME.fontUi}`;
    if (over) c.fillText('▲', mx, 8);
    if (under) c.fillText('▼', mx, H - 2);
  }

  /** XY: (A, B) mids of the newest entries as dots, older ones fainter. */
  function xy(c: CanvasRenderingContext2D, ring: Float32Array, start: number, len: number, ga: number, gb: number, alpha: number) {
    const n = Math.min(len, 256);
    const from = (start + len - n) | 0;
    const BUCKETS = 8;
    c.fillStyle = A;
    for (let k = 0; k < BUCKETS; k++) {
      c.globalAlpha = alpha * ((k + 1) / BUCKETS);
      for (let i = Math.floor((k * n) / BUCKETS); i < Math.floor(((k + 1) * n) / BUCKETS); i++) {
        const at = ((from + i) & MASK) << 2;
        const a = (ring[at] + ring[at + 1]) * 0.5 * ga;
        const b = (ring[at + 2] + ring[at + 3]) * 0.5 * gb;
        c.fillRect(W / 2 + a * (W / 2) - 0.75, H / 2 - b * (H / 2) - 0.75, 1.5, 1.5);
      }
    }
    c.globalAlpha = alpha;
  }

  // Sync draws the last whole division from this copy (scopeMath.ts: its
  // start leaves the readable range late in the next division).
  const hold = createSyncHold();
  let holdSlot = -1;

  /** Draws; true while the rings still move (keeps the driver in the loop). */
  function frame(now: number, v: VisViews): boolean {
    if (frozen) return false;
    bind(v);
    const s = findScope(hdrs, track, idx);
    if (s !== holdSlot) {
      hold.has = false;
      holdSlot = s;
    }
    const hdr = s >= 0 ? slotHdr[s] : null;
    const head = hdr ? Atomics.load(hdr, SCOPE_HDR.head) : 0;
    if (s !== last[1] || head !== last[0]) lastMove = now;
    const idle = s < 0 || now - lastMove > IDLE_MS;
    const busy = !idle;
    if (!changed(head, s, idle)) return busy;

    const c = canvas.getContext('2d');
    if (!c) return busy;
    const want = Math.max(1, Math.round(window.devicePixelRatio || 1));
    if (want !== dpr || canvas.width !== W * want) {
      dpr = want;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    grid(c);

    const sync = (params[1] ?? 0) >= 0.5;
    const division = DIVISIONS[Math.round(params[2] ?? 3)] ?? '';
    const isXY = (params[5] ?? 0) >= 0.5;
    const trig = Math.round(params[6] ?? 0);
    let tag = idle ? 'idle' : '';
    if (hdr && s >= 0) {
      const ring = rings[s];
      const decim = Math.max(1, hdr[SCOPE_HDR.decim]);
      const len = windowLen(windowFrames({ time: params[0] ?? 5, sync, division: params[2] ?? 3 }, sampleRate, tempo), decim);
      const alpha = idle ? 0.45 : 1;
      c.globalAlpha = alpha;
      c.save();
      c.beginPath();
      c.rect(0, 0, W, H);
      c.clip();
      if (isXY) {
        const w = scopeWindow(ring, hdr, { sync: false, trig: 1 }, len);
        xy(c, ring, w.start, w.len, params[3] ?? 1, params[4] ?? 1, alpha);
      } else {
        const w = scopeWindow(ring, hdr, { sync, trig }, len, hold);
        const src = w.held ? hold.buf : ring;
        if (w.len > 0) {
          trace(c, src, w.start, w.len, 0, params[3] ?? 1, A, decim === 1);
          if (hdr[SCOPE_HDR.flags] & SCOPE_FLAG.b) trace(c, src, w.start, w.len, 2, params[4] ?? 1, B, decim === 1);
        }
        if (!tag && trig === 0 && !w.triggered && w.len > 0) tag = 'no trig';
      }
      c.restore();
    }
    c.globalAlpha = 1;
    c.font = `9px ${THEME.fontMono}`;
    c.fillStyle = THEME.textDim;
    c.textBaseline = 'alphabetic';
    const text = readout(params[0] ?? 5, sync, division);
    c.fillText(text, 4, H - 4);
    // What the canvas says, for tests and the curious (written only on a redraw).
    if (box.dataset.readout !== text) box.dataset.readout = text;
    if (box.dataset.tag !== tag) box.dataset.tag = tag;
    if (isXY) c.fillText('XY', W - 16, H - 4);
    if (tag) {
      c.fillStyle = tag === 'idle' ? THEME.textDim : THEME.rec;
      const tw = c.measureText(tag).width;
      c.fillText(tag, W - tw - 4, 11);
    }
    return busy;
  }

  // An idle driver: once the transport is stopped and the rings' heads have
  // not moved for IDLE_MS + 0.5 s (the "idle" tag is drawn first) the scope
  // leaves the loop; Play, a note or an edit kicks it back. A param, rate or
  // tempo change or an unfreeze kicks it too, so the last frame is redrawn.
  let driver: IdleDriver | null = null;
  onMount(() => {
    driver = createIdleDriver({ loop: frameLoop(), want: VIS_WANT.scopes, el: canvas, frame });
    driver.kick();
    return () => {
      driver?.stop();
      driver = null;
    };
  });
  $effect(() => {
    void params.join(','); void sampleRate; void tempo; void frozen;
    driver?.kick();
  });
</script>

<button
  class="scope" class:frozen bind:this={box} data-testid={`scope-${idx}`} aria-pressed={frozen}
  aria-label={frozen ? 'Scope frozen: click to run' : 'Scope: click to freeze'} title={frozen ? 'Frozen — click to run' : 'Click to freeze'}
  onclick={() => (frozen = !frozen)}
>
  <canvas bind:this={canvas} width={W} height={H} style:width={`${W}px`} style:height={`${H}px`}></canvas>
  {#if frozen}<span class="pause" aria-hidden="true">❚❚</span>{/if}
</button>

<style>
  /* An --lcd screen in a well (tokens only); frozen: a cv-blue ring and pause mark. */
  .scope { position: relative; display: block; padding: 0; margin: 0 auto; border: 0; border-radius: var(--r-sm); background: var(--lcd); box-shadow: var(--well-shadow); cursor: pointer; line-height: 0; overflow: hidden; }
  .scope:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .scope.frozen { box-shadow: var(--well-shadow), inset 0 0 0 1px var(--sig-cv); }
  canvas { display: block; }
  .pause { position: absolute; top: 3px; left: 4px; font-size: 9px; line-height: 1; color: var(--sig-cv); }
</style>
