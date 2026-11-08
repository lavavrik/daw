<script lang="ts">
  // The ADSR / LFO shape preview (plan 12 Task 5; docs/architecture/
  // visuals.md "Shape previews"), above the knobs in its ModulePanel.
  //
  // - A 120 × 40 px SVG and a one-line label with the real times
  //   ("5 ms · 200 ms · 70% · 300 ms" / "2.00 Hz · 500 ms" / "1/4 · 500 ms").
  //   The curves and the √t time axis are ui/vis/shapes.ts, checked against
  //   the engine's own ADSR and LFO (engine/tests/fixtures/shapes.json).
  // - Static: no frame loop. It redraws when a param (or the tempo, for a
  //   synced LFO) changes, and when an automation lane on one of its
  //   continuous params moves: like Knob.svelte it registers those params
  //   with the app's autoBus and draws the lane's heard value while the
  //   lane applies (the knob rings show the same values). Changes only mark
  //   it dirty: it draws at most once per animation frame (one rAF, not the
  //   frame loop), writing the SVG attributes directly (no Svelte state).
  // - The ADSR label is compact ("5ms·200ms·70%·300ms", clamped to fit
  //   120 px with an ellipsis); the full text ("5 ms · 200 ms · …") is the
  //   title and what screen readers read. The SVG itself is aria-hidden.
  // - ADSR: drawn at full velocity; with Velocity > 0 a dashed curve shows
  //   the softest note (level × (1 − vel_amt)). Faint ticks mark the
  //   segment edges.
  // - LFO: one cycle from the engine's phase 0 (synced: on the beat), ±depth
  //   inside the dim ±1 frame.
  import { untrack } from 'svelte';
  import type { ModuleDef } from '../../audio/catalog';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import { useAutoBus } from '../autoBus';
  import { adsrCompactLabel, adsrLabel, adsrLayout, adsrPoints, lfoLabel, lfoPoints } from '../vis/shapes';

  let { def, idx, params, owner = null, tempo = 120, color = 'var(--accent)' }: {
    /** The ADSR's or the LFO's catalog def. */
    def: ModuleDef;
    /** The module idx (its automation targets). */
    idx: number;
    /** Its params, catalog order (module.params). */
    params: number[];
    /** The synth track's id: lanes on its params move the preview (null: no lanes). */
    owner?: MixChannelTarget | null;
    /** Transport BPM (a synced LFO's period). */
    tempo?: number;
    /** The curve's colour (the module's category colour; any CSS colour). */
    color?: string;
  } = $props();

  const W = 120;
  const H = 40;
  const PAD = 3;

  let line = $state<SVGPathElement | null>(null);
  let fill = $state<SVGPathElement | null>(null);
  let soft = $state<SVGPathElement | null>(null);
  let ticks = $state<SVGPathElement | null>(null);
  let svg = $state<SVGSVGElement | null>(null);
  let label = $state<HTMLElement | null>(null);
  let shortEl = $state<HTMLElement | null>(null);
  let fullEl = $state<HTMLElement | null>(null);

  /** The label: `short` shown, `full` as the title and for screen readers. */
  function setLabel(short: string, full: string) {
    if (shortEl) shortEl.textContent = short;
    if (fullEl) fullEl.textContent = full;
    label?.setAttribute('title', full);
  }

  /** A lane's heard value per param index while it applies (null / missing: the knob's own). */
  const heard: (number | null)[] = [];
  const indexOf = (name: string) => def.params.findIndex((p) => p.name === name);
  /** What the knob shows: the lane's heard value, else the param. */
  const val = (name: string, d: number) => {
    const i = indexOf(name);
    if (i < 0) return d;
    return heard[i] ?? params[i] ?? def.params[i].default;
  };

  const path = (pts: [number, number][], x: (v: number) => number, y: (v: number) => number) =>
    pts.map(([a, b], i) => `${i ? 'L' : 'M'}${x(a).toFixed(2)} ${y(b).toFixed(2)}`).join('');

  function drawAdsr() {
    const p = { attack: val('attack', 0.005), decay: val('decay', 0.2), sustain: val('sustain', 0.7), release: val('release', 0.3), delay: val('delay', 0) };
    const amt = Math.min(1, Math.max(0, val('vel_amt', 0)));
    const pts = adsrPoints(p);
    const x = (v: number) => v * W;
    const y = (v: number) => H - PAD - v * (H - 2 * PAD);
    const d = path(pts, x, y);
    line?.setAttribute('d', d);
    fill?.setAttribute('d', `${d}L${W} ${H - PAD}L0 ${H - PAD}Z`);
    soft?.setAttribute('d', amt > 0 ? path(pts, x, (v) => y(v * (1 - amt))) : '');
    const segs = adsrLayout(p);
    ticks?.setAttribute('d', segs.slice(1).filter((s) => s.x0 > 0).map((s) => `M${(s.x0 * W).toFixed(2)} ${PAD}V${H - PAD}`).join(''));
    if (svg) {
      // Test hooks (e2e): each segment's width in px.
      for (const s of segs) svg.dataset[s.kind] = ((s.x1 - s.x0) * W).toFixed(2);
    }
    setLabel(adsrCompactLabel(p), adsrLabel(p));
  }

  function drawLfo() {
    const lp = { wave: val('wave', 0), rate: val('rate', 2), sync: val('sync', 0), division: val('division', 3), depth: val('depth', 1) };
    const pts = lfoPoints(lp.wave, lp.depth);
    const y = (v: number) => H / 2 - v * (H / 2 - PAD);
    const d = path(pts, (v) => v * W, y);
    line?.setAttribute('d', d);
    fill?.setAttribute('d', `${d}L${W} ${H / 2}L0 ${H / 2}Z`);
    soft?.setAttribute('d', '');
    ticks?.setAttribute('d', `M0 ${PAD}H${W}M0 ${H - PAD}H${W}M${W / 2} ${PAD}V${H - PAD}`);
    if (svg) svg.dataset.depth = lp.depth.toFixed(3);
    const divisions = def.params[indexOf('division')]?.choices;
    const text = lfoLabel(lp, tempo, divisions?.length ? divisions : undefined);
    setLabel(text, text);
  }

  function draw() {
    if (def.id === 'adsr') drawAdsr();
    else drawLfo();
  }

  // Coalescing: any number of changes in one frame draw once, at the next
  // animation frame.
  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }
  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });

  // Redraw when a param, the tempo or an element changes.
  $effect(() => {
    void [line, fill, soft, ticks, svg, label, shortEl, fullEl, def, tempo];
    for (let i = 0; i < params.length; i++) void params[i];
    schedule();
  });

  // Lanes: the continuous params, like Knob.svelte (choice / integer params have none).
  const bus = useAutoBus();
  $effect(() => {
    if (!bus || !owner) return;
    const o = owner;
    const offs = untrack(() =>
      def.params.flatMap((pd, i) =>
        pd.choices.length || pd.integer
          ? []
          : [bus.register(o, { kind: 'rack', module: idx, param: pd.name }, (v) => {
            if (heard[i] === v.value) return;
            heard[i] = v.value;
            schedule();
          })],
      ),
    );
    return () => {
      for (const off of offs) off();
      heard.length = 0;
      schedule();
    };
  });
</script>

<div class="shape" style:--c={color}>
  <svg bind:this={svg} data-testid={`shape-${def.id}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
    {#if def.id === 'lfo'}<line class="zero" x1="0" x2={W} y1={H / 2} y2={H / 2} />{/if}
    <path class="ticks" bind:this={ticks} />
    <path class="fill" bind:this={fill} />
    <path class="soft" bind:this={soft} />
    <path class="line" bind:this={line} />
  </svg>
  <span class="label" bind:this={label}>
    <span aria-hidden="true" data-testid={`shape-label-${def.id}`} bind:this={shortEl}></span><span class="sr-only" bind:this={fullEl}></span>
  </span>
</div>

<style>
  /* An --lcd screen in a well (tokens only); the curve in the module's colour. */
  .shape { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 0 auto; }
  svg { display: block; border-radius: var(--r-sm); background: var(--lcd); box-shadow: var(--well-shadow); overflow: hidden; }
  .line { fill: none; stroke: var(--c); stroke-width: 1.5; stroke-linejoin: round; }
  .fill { fill: var(--c); opacity: 0.18; stroke: none; }
  .soft { fill: none; stroke: var(--c); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0.55; }
  .ticks { fill: none; stroke: var(--text); stroke-width: 1; opacity: 0.08; }
  .zero { stroke: var(--text); stroke-width: 1; opacity: 0.15; }
  .label { max-width: 120px; overflow: hidden; text-overflow: ellipsis; font: 9px var(--font-mono); color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
</style>
