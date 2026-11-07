<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  /**
   * Track ids whose rack was edited since its patch was loaded: drives the
   * "(edited)" marker next to the patch name. UI state only (not saved, not
   * in Project); module-level so it survives switching tracks/tabs.
   */
  const edited = new SvelteSet<string>();
</script>

<script lang="ts">
  // The Instrument tab: a VCV-Rack-style rail of module panels, with cables
  // drawn on an SVG layer above them.
  //
  // Layout: `.rail` is the horizontal scroller; `.content` (position:
  // relative, width = all panels) holds the panels AND the cable <svg>, so
  // cables scroll with the panels. Jack centres are measured relative to
  // `.content` (see measure()) on patch change, ResizeObserver and scroll.
  //
  // Cables: the SVG has `pointer-events: none` everywhere, so it never steals
  // clicks from knobs. Cables are grabbed by their INPUT jack instead (VCV
  // style): pressing a connected input lifts that cable's plug and carries
  // it; pressing an output starts a new cable; pressing an empty input starts
  // a cable to be dropped on an output. During a drag nothing is sent; on
  // drop the target is found with document.elementFromPoint(...) and
  // closest('[data-jack]'), and exactly one engine edit (or one disconnect +
  // connect pair) is sent. Drops on anything that is not a matching jack
  // unplug a carried cable / cancel a new one.
  import { tick } from 'svelte';
  import { CATALOG, moduleDef } from '../../audio/catalog';
  import type { SignalKind } from '../../audio/catalog';
  import type { AudioEngine } from '../../audio/engine';
  import { confirmReleasingKeys } from '../../input/shortcuts';
  import { STARTER_PATCHES } from '../../state/patches';
  import type { Project, SynthTrack } from '../../state/project.svelte';
  import { addModule, connect, disconnect, loadPatch, removeModule, setParam } from '../../state/rack-actions';
  import { cableBottom, cablePath, categoryColor, SIGNAL_COLORS } from './cables';
  import type { Pt } from './cables';
  import ModulePanel from './ModulePanel.svelte';

  let { p, engine, track }: { p: Project; engine: AudioEngine; track: SynthTrack } = $props();

  type End = { m: number; port: number };
  const key = (m: number, dir: 'in' | 'out', port: number) => `${m}:${dir}:${port}`;

  // ---- modules -------------------------------------------------------------
  const modules = $derived([...track.modules].sort((a, b) => a.idx - b.idx));
  /** "Oscillator 1", "Oscillator 2" when a kind appears more than once. */
  const titles = $derived.by(() => {
    const total = new Map<number, number>();
    for (const m of modules) total.set(m.kind, (total.get(m.kind) ?? 0) + 1);
    const seen = new Map<number, number>();
    const out = new Map<number, string>();
    for (const m of modules) {
      const n = (seen.get(m.kind) ?? 0) + 1;
      seen.set(m.kind, n);
      const name = moduleDef(m.kind).name;
      out.set(m.idx, total.get(m.kind)! > 1 ? `${name} ${n}` : name);
    }
    return out;
  });
  const full = $derived(track.modules.length >= CATALOG.maxModules);
  const isEdited = $derived(edited.has(track.id));

  function signalOf(m: number, dir: 'in' | 'out', port: number): SignalKind {
    const mod = track.modules.find((x) => x.idx === m);
    if (!mod) return 'audio';
    const d = moduleDef(mod.kind);
    return (dir === 'in' ? d.inputs : d.outputs)[port]?.signal ?? 'audio';
  }

  // ---- jack positions --------------------------------------------------------
  let rail = $state<HTMLElement | null>(null);
  let content = $state<HTMLElement | null>(null);
  let pos = $state<Record<string, Pt>>({});
  let size = $state({ w: 0, h: 0 });
  let measureRaf = 0;

  function measure() {
    measureRaf = 0;
    if (!content) return;
    const r0 = content.getBoundingClientRect();
    const next: Record<string, Pt> = {};
    for (const el of content.querySelectorAll<HTMLElement>('[data-jack]')) {
      const r = (el.querySelector('.hole') ?? el).getBoundingClientRect();
      next[key(Number(el.dataset.m), el.dataset.dir as 'in' | 'out', Number(el.dataset.port))] = {
        x: r.left - r0.left + r.width / 2,
        y: r.top - r0.top + r.height / 2,
      };
    }
    pos = next;
    // client* = the panels' box only. Not scroll*: that would include the
    // cable SVG itself (sized from this) and grow on every measure.
    size = { w: content.clientWidth, h: content.clientHeight };
    // Mid-drag scroll/resize: the carried end stays under the pointer.
    if (drag) drag.at = { x: drag.client.x - r0.left, y: drag.client.y - r0.top };
  }
  /** Coalesced to one measure per frame (scroll and resize fire often). */
  function remeasure() {
    if (!measureRaf) measureRaf = requestAnimationFrame(measure);
  }

  // Patch change: modules or cables changed -> wait for the DOM, then measure.
  $effect(() => {
    // loadPatch/connect/disconnect/removeModule reassign these arrays and
    // addModule pushes, so identity + length covers every structural edit
    // (param changes don't move jacks and are deliberately not tracked).
    void [track.modules, track.modules.length, track.cables, track.cables.length];
    void tick().then(measure);
  });
  $effect(() => {
    if (!rail || !content) return;
    const ro = new ResizeObserver(remeasure);
    ro.observe(rail);
    ro.observe(content);
    rail.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    const r = rail;
    return () => {
      ro.disconnect();
      r.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      if (measureRaf) cancelAnimationFrame(measureRaf);
      measureRaf = 0;
    };
  });

  // ---- cables ----------------------------------------------------------------
  type Drag = {
    /** The end that stays put: an output, or (new cable from an empty input) an input. */
    fixed: End & { dir: 'in' | 'out' };
    /** Input whose existing cable is being carried (unplugged visually, not yet in the engine). */
    carry: End | null;
    signal: SignalKind;
    /** Carried end, relative to `.content`. */
    at: Pt;
    /** Last pointer position (viewport), to re-derive `at` after a scroll. */
    client: Pt;
  };
  let drag = $state<Drag | null>(null);

  const drawn = $derived(
    track.cables
      .filter((c) => !(drag?.carry && drag.carry.m === c.to.m && drag.carry.port === c.to.port))
      .map((c) => ({
        id: key(c.to.m, 'in', c.to.port),
        a: pos[key(c.from.m, 'out', c.from.port)],
        b: pos[key(c.to.m, 'in', c.to.port)],
        color: SIGNAL_COLORS[signalOf(c.from.m, 'out', c.from.port)],
      }))
      .filter((c) => c.a && c.b),
  );
  const dragA = $derived(drag ? pos[key(drag.fixed.m, drag.fixed.dir, drag.fixed.port)] : null);
  /**
   * The SVG (absolutely positioned inside the scrolled `.content`, so it
   * extends the rail's scroll area) is tall enough for the lowest point of
   * every cable: none is clipped or out of reach.
   */
  const svgH = $derived(Math.ceil(Math.max(size.h, ...drawn.map((c) => cableBottom(c.a, c.b) + 8))));

  function local(e: PointerEvent): Pt {
    const r = content!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function jackDown(e: PointerEvent, m: number, dir: 'in' | 'out', port: number) {
    if (e.button !== 0 || !content || drag) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const client = { x: e.clientX, y: e.clientY };
    const existing = dir === 'in' ? track.cables.find((c) => c.to.m === m && c.to.port === port) : undefined;
    drag = existing
      ? { fixed: { ...existing.from, dir: 'out' }, carry: { m, port }, signal: signalOf(existing.from.m, 'out', existing.from.port), at: local(e), client }
      : { fixed: { m, port, dir }, carry: null, signal: signalOf(m, dir, port), at: local(e), client };

    const move = (ev: PointerEvent) => {
      if (!drag) return;
      drag.client = { x: ev.clientX, y: ev.clientY };
      drag.at = local(ev);
    };
    const cleanup = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', esc, true);
      const d = drag;
      drag = null;
      return d;
    };
    const up = (ev: PointerEvent) => {
      const d = cleanup();
      if (d) drop(d, document.elementFromPoint(ev.clientX, ev.clientY));
    };
    // Cancel = leave everything as it was (a carried cable snaps back).
    // lostpointercapture without a pointerup (e.g. the window lost the
    // pointer) must not leave a phantom cable following nothing.
    const cancel = () => void cleanup();
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation(); // don't also close a menu etc.
      cleanup();
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', esc, true);
  }

  function drop(d: Drag, under: Element | null) {
    const t = under?.closest<HTMLElement>('[data-jack]');
    const tgt = t && content?.contains(t)
      ? { m: Number(t.dataset.m), port: Number(t.dataset.port), dir: t.dataset.dir as 'in' | 'out' }
      : null;
    if (d.fixed.dir === 'out') {
      const from = { m: d.fixed.m, port: d.fixed.port };
      if (tgt?.dir === 'in') {
        if (d.carry && d.carry.m === tgt.m && d.carry.port === tgt.port) return; // put back where it was
        if (d.carry) disconnect(p, engine, track.id, d.carry);
        connect(p, engine, track.id, from, tgt); // replaces any cable already on tgt
        edited.add(track.id);
      } else if (d.carry) {
        disconnect(p, engine, track.id, d.carry); // dropped on nothing: unplug
        edited.add(track.id);
      }
    } else if (tgt?.dir === 'out') {
      connect(p, engine, track.id, tgt, { m: d.fixed.m, port: d.fixed.port });
      edited.add(track.id);
    }
  }

  // ---- edits ------------------------------------------------------------------
  function param(idx: number, i: number, v: number) {
    setParam(p, engine, track.id, idx, i, v);
    edited.add(track.id);
  }
  function remove(idx: number) {
    removeModule(p, engine, track.id, idx);
    edited.add(track.id);
  }
  /**
   * Replaces the rack. With unsaved edits it asks first: a stray arrow key on
   * a focused select (Windows/Linux change the value without opening it) or
   * a misclick must not silently throw work away. Undo arrives in plan 6.
   */
  function load(name: string): boolean {
    const patch = STARTER_PATCHES.find((x) => x.name === name);
    if (!patch) return false;
    // confirmReleasingKeys: a piano key held during the dialog would hang.
    if (isEdited && !confirmReleasingKeys(`Discard your edits to "${track.patchName}"?`)) return false;
    loadPatch(p, engine, track.id, patch);
    edited.delete(track.id);
    return true;
  }
  function pickPatch(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    sel.blur(); // give the keys back to the piano at once
    if (!load(sel.value)) sel.value = track.patchName; // declined: show the current patch again
  }
  const revert = () => load(track.patchName);
  /** A focused <select> type-aheads on letters: the piano keys must not change the patch. */
  function selectKey(e: KeyboardEvent) {
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
  }

  // ---- add-module menu ---------------------------------------------------------
  const CATEGORY_ORDER = ['source', 'shaping', 'effect', 'utility'];
  const groups = $derived.by(() => {
    const cats = [...new Set(CATALOG.modules.map((m) => m.category))];
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : 99);
    cats.sort((a, b) => rank(a) - rank(b));
    return cats.map((c) => ({ category: c, modules: CATALOG.modules.filter((m) => m.category === c) }));
  });
  let menuOpen = $state(false);
  let menuEl = $state<HTMLElement | null>(null);
  let menuBtn = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl?.contains(t) && !menuBtn?.contains(t)) menuOpen = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      menuOpen = false;
      menuBtn?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', esc);
    void tick().then(() => menuEl?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', esc);
    };
  });

  async function add(id: string) {
    menuOpen = false;
    const idx = addModule(p, engine, track.id, id);
    if (idx === null) return;
    edited.add(track.id);
    await tick();
    content?.querySelector(`[data-testid="module-${idx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
</script>

<div class="rack" data-testid="rack">
  <div class="bar">
    <label class="patch">
      <span>Patch</span>
      <select data-testid="patch-select" value={track.patchName} onchange={pickPatch} onkeydown={selectKey}>
        {#if !STARTER_PATCHES.some((x) => x.name === track.patchName)}
          <option value={track.patchName} disabled>{track.patchName || '—'}</option>
        {/if}
        {#each STARTER_PATCHES as sp (sp.name)}
          <option value={sp.name}>{sp.name}</option>
        {/each}
      </select>
    </label>
    {#if isEdited}
      <span class="edited" data-testid="patch-edited" title="Changed since the patch was loaded">(edited)</span>
      <button class="link" onclick={revert} title={`Reload ${track.patchName}, discarding your changes`}>revert</button>
    {/if}
    <div class="addwrap">
      <button
        class="add"
        bind:this={menuBtn}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >+ Add module</button>
      {#if menuOpen}
        <div class="menu" role="menu" data-testid="add-menu" bind:this={menuEl}>
          {#if full}
            <p class="full">Rack is full ({CATALOG.maxModules} modules). Remove one first.</p>
          {:else}
            {#each groups as g (g.category)}
              <div class="group" style:--c={categoryColor(g.category)}>
                <div class="gh">{g.category[0].toUpperCase() + g.category.slice(1)}</div>
                {#each g.modules as md (md.id)}
                  <button role="menuitem" data-testid={`add-${md.id}`} onclick={() => add(md.id)}>{md.name}</button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
    <span class="legend" aria-label="Cable colours">
      {#each Object.entries(SIGNAL_COLORS) as [sig, col] (sig)}
        <span><i style:background={col}></i>{sig}</span>
      {/each}
    </span>
  </div>

  <div class="rail" data-testid="rail" bind:this={rail}>
    <div class="content" bind:this={content}>
      {#each modules as m (m.idx)}
        <ModulePanel
          module={m}
          def={moduleDef(m.kind)}
          title={titles.get(m.idx) ?? ''}
          isConnected={(port) => track.cables.some((c) => c.to.m === m.idx && c.to.port === port)}
          onparam={(i, v) => param(m.idx, i, v)}
          onremove={() => remove(m.idx)}
          onjackdown={(e, dir, port) => jackDown(e, m.idx, dir, port)}
        />
      {/each}
      {#if modules.length === 0}
        <p class="empty">Empty rack — pick a patch or add modules. A synth needs at least MIDI In → Oscillator → Out.</p>
      {/if}
      <svg class="cables" data-testid="cables" width={size.w} height={svgH} aria-hidden="true">
        {#each drawn as c (c.id)}
          <path class="cable" d={cablePath(c.a, c.b)} stroke={c.color} />
          <circle class="plug" cx={c.a.x} cy={c.a.y} r="3.5" fill={c.color} />
          <circle class="plug" cx={c.b.x} cy={c.b.y} r="3.5" fill={c.color} />
        {/each}
        {#if drag && dragA}
          <path class="drag" d={cablePath(dragA, drag.at)} stroke={SIGNAL_COLORS[drag.signal]} />
          <circle class="plug" cx={drag.at.x} cy={drag.at.y} r="4.5" fill={SIGNAL_COLORS[drag.signal]} />
        {/if}
      </svg>
    </div>
  </div>
</div>

<style>
  .rack { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .patch { display: flex; align-items: center; gap: 6px; color: #8d90a0; }
  select { font: inherit; background: #24262c; color: #e6e7ec; border: 1px solid #3a3d48; border-radius: 3px; padding: 2px 4px; }
  .edited { color: #ffd98a; font-size: 11px; }
  .link { font: inherit; font-size: 11px; border: 0; background: transparent; color: #8fb8ff; cursor: pointer; padding: 0; text-decoration: underline; }
  .addwrap { position: relative; }
  .add { font: inherit; padding: 3px 10px; border: 1px solid #3a3d48; border-radius: 3px; background: #24262c; color: #c9cbd3; cursor: pointer; }
  .add:hover, .add[aria-expanded='true'] { background: #2e313a; color: #fff; }
  select:focus-visible, .add:focus-visible, .link:focus-visible { outline: 2px solid #f0a23a; outline-offset: -1px; }
  .menu { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; display: flex; gap: 10px; padding: 8px; background: #1f2127; border: 1px solid #3a3d48; border-radius: 4px; box-shadow: 0 6px 20px #000a; }
  .group { display: flex; flex-direction: column; gap: 1px; min-width: 96px; }
  .gh { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c); border-bottom: 2px solid var(--c); margin-bottom: 3px; padding-bottom: 1px; }
  .group button { font: inherit; text-align: left; padding: 3px 6px; border: 0; border-radius: 2px; background: transparent; color: #d7d9e0; cursor: pointer; white-space: nowrap; }
  .group button:hover, .group button:focus-visible { background: #2e313a; outline: none; color: #fff; }
  .full { margin: 0; color: #ffd98a; white-space: nowrap; }
  .legend { margin-left: auto; display: flex; gap: 8px; color: #8d90a0; font-size: 10px; }
  .legend span { display: flex; align-items: center; gap: 3px; }
  .legend i { width: 12px; height: 3px; border-radius: 2px; }

  .rail { flex: 1; min-height: 0; min-width: 0; overflow: auto; background: #101114; border-radius: 4px; }
  .content { position: relative; display: flex; align-items: stretch; gap: 4px; width: max-content; min-width: 100%; box-sizing: border-box; padding: 6px; }
  .empty { color: #7d808c; margin: 8px; }
  .cables { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .cable, .drag { fill: none; stroke-width: 3.5; stroke-linecap: round; opacity: 0.82; }
  .drag { opacity: 1; stroke-dasharray: 6 4; }
  .plug { opacity: 0.95; }
</style>
