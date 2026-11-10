<script lang="ts">
  // One mixer strip: a track, a return (Reverb / Delay) or the Master.
  // Top to bottom (anti-goal: never guess what a control is or what it is set
  // to — every control is labelled and shows its value):
  //   name (track colour; click selects the track) · M / S · ∿ (show this
  //   strip in the analyser; tracks and returns, one at a time, again = back
  //   to the Master; view state owned by ui/vis/analyserBus.ts) ·
  //   EQ (collapsed, "on" toggle in its header) ·
  //   Comp (tracks; collapsed, "on" toggle, the sidechain source always shown
  //   as "SC: Drums · kick", live gain reduction) ·
  //   Reverb / Delay settings (returns) · Sends (tracks; below) · Pan ·
  //   Limiter ceiling + GR (master) · fader | dB scale | stereo meter ·
  //   fader readout.
  //
  // Returns (plan 29): the header shows the return's colour dot
  // (`--return-<slot>`), its name and returnSummary as the subtitle ("Reverb
  // · 1.8 s"); its knobs wear the colour too. Double-clicking the name edits
  // it in place (`return-name-input`: Enter or a click away saves through
  // renameReturn, Esc cancels; a refused name keeps the old one). Its Presets
  // card ends with "Delete return" (deleteReturn: one undo entry).
  //
  // Sends (tracks, plan 29 option C): a folding Section like EQ / Comp,
  // closed by default (view state, per strip), not rendered with no returns.
  // Closed it shows SendBars (one mini bar per return, in creation order and
  // colour; a click opens the section) and "k of n" (sends above −∞); open,
  // a knob per return, two per row, ring in the return's colour, labelled
  // with the return's name, each with its pre/post button. A send is the
  // catalog param send_a..send_h of the return's slot (protocol sendParam).
  // All edits go through mixer-actions.ts (state + engine command); knobs and
  // the fader coalesce their sends to one per animation frame. Every
  // continuous knob and the fader follow their automation lane (`auto`,
  // plan 10 Task 4) and offer "Automate" on right-click.
  //
  // Look (plan 21 Task 10; spec §11: the rack's mechanical faceplate on the
  // mixer "patches"): a .mech-panel with four corner screws and a header
  // strip (.mech-head) in the track colour; M / S / ∿ are LED push-buttons
  // (.mech-btn under a .led that glows in the button's colour when on); the
  // EQ, Comp, return, send, pan and limiter knobs are mech knobs, compact
  // ('sm', 46 px), two per row; the fader is the mech fader (Fader.svelte).
  // Meters unchanged.
  //
  // Presets (plan 27 Task 1; docs/architecture/mixer.md "Strip presets"): a
  // small button at the header's right end opens a floating PopButton card
  // listing the strip kind's presets (state/mixerPresets.ts: one undo entry
  // each) and, on a track strip that is not the Kick's own drum track,
  // Duck to kick (mixer-actions duckToKick; a refusal is flashed in the top
  // bar's status). The card floats (fixed) because the strip clips.
  import type { AudioEngine } from '../../audio/engine';
  import { MIX_PARAMS, mixParam } from '../../audio/mixerCatalog';
  import type { MixParamDef, MixTarget } from '../../audio/mixerCatalog';
  import { MAX_KEYS, MIX_METER_STRIDE, sendParam, sendPreParam } from '../../audio/protocol';
  import type { ChannelState, Project, SidechainKey } from '../../state/project.svelte';
  import { channelState, duckToKick, keyLabel, kickKey, pickSidechain, rowKeyAllowed, setMix, toggleMute, toggleSolo } from '../../state/mixer-actions';
  import { KIND_NAME, RETURN_NAME_MAX, deleteReturn, findReturn, renameReturn, returnColor } from '../../state/returns';
  import SendBars from './SendBars.svelte';
  import { applyPreset, presetsFor } from '../../state/mixerPresets';
  import type { PresetKind } from '../../state/mixerPresets';
  import { flashHint } from '../../state/banners.svelte';
  import PopButton from '../PopButton.svelte';
  import SlidersHorizontal from 'phosphor-svelte/lib/SlidersHorizontal';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import Knob from '../rack/Knob.svelte';
  import Fader from './Fader.svelte';
  import { releaseSelect, selectKey } from '../selectKey';
  import { soloTitle } from '../soloTitle';
  import Meter from './Meter.svelte';
  import Section from './Section.svelte';
  import { tick, untrack } from 'svelte';
  import { useAutoBus } from '../autoBus';
  import type { MeterBus } from './meterBus';
  import { SCALE_TICKS, delayClampNote, faderPos, formatDb } from './mixMath';
  import { analyserBus } from '../vis/analyserBus';
  import Equalizer from 'phosphor-svelte/lib/Equalizer';
  import ArrowsInLineVertical from 'phosphor-svelte/lib/ArrowsInLineVertical';
  import Waveform from 'phosphor-svelte/lib/Waveform';
  import Icon from '../Icon.svelte';

  let { p, engine, bus, target, kind, channel, name, color = null, subtitle = '', selected = false, onselect }: {
    p: Project;
    engine: AudioEngine;
    bus: MeterBus;
    /** Track id, a return's id, or 'master'. */
    target: MixChannelTarget;
    kind: MixTarget;
    /** Mixer channel index (meters): track slot or MIX_*. */
    channel: number;
    name: string;
    /** Track colour; null = neutral (returns, master). */
    color?: string | null;
    subtitle?: string;
    selected?: boolean;
    onselect?: () => void;
  } = $props();

  /** This strip's return (undefined: a track or the master). */
  const ret = $derived(kind === 'return' ? findReturn(p, target) : undefined);
  /** The knobs' colour: the track's, the return's (`--return-<slot>`), or a neutral for the master. */
  const knobColor = $derived(color ?? (ret ? returnColor(ret.slot) : 'var(--text-dim)'));
  const ch = $derived<ChannelState | undefined>(channelState(p, target));
  /** A return's effect (null: a track or the master). */
  const retKind = $derived(ret?.kind ?? null);
  const val = (n: string) => ch?.params[mixParam(n).id] ?? mixParam(n).default;
  const set = (n: string, v: number) => setMix(p, engine, target, n, v);
  /** The lane target of mixer param `n` on this channel (Knob / Fader follow it: ui/autoBus.ts). */
  const autoOf = (n: string) => ({ owner: target, target: { kind: 'mix' as const, param: n } });

  const group = (g: string): MixParamDef[] => MIX_PARAMS.filter((d) => d.group === g && d.appliesTo.includes(kind));
  const eqKnobs = $derived(group('eq').filter((d) => d.name !== 'eq_on'));
  const compKnobs = $derived(group('comp').filter((d) => d.name !== 'comp_on'));
  const fxKnobs = $derived(retKind ? group(retKind) : []);
  const ceilingDb = $derived(kind === 'master' ? val('limiter_ceiling') : 0);

  // ---- presets -------------------------------------------------------------
  const presets = $derived(presetsFor(kind === 'track' ? 'track' : kind === 'master' ? 'master' : (retKind ?? 'reverb') as PresetKind));
  /** Duck to kick is offered on track strips, except the drum track that plays the Kick. */
  const canDuck = $derived(kind === 'track' && kickKey(p)?.trackId !== target);
  const presetsTitle = $derived(
    kind === 'track' ? `Presets: EQ, comp and sends in one go${canDuck ? '; Duck to kick' : ''}`
    : kind === 'master' ? 'Presets: the master EQ and limiter in one go'
    : `Presets: this return's EQ and ${retKind ?? 'effect'} in one go`,
  );
  function duck() {
    const r = duckToKick(p, engine, target);
    if (!r.ok) flashHint(r.reason);
  }
  /** ArrowUp / ArrowDown move between the menu's items (wrapping), as AutoMenu's list; Home / End jump to the first / last. */
  function menuArrows(e: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button')];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length;
    all[to]?.focus();
  }

  // ---- return: rename in place, delete ---------------------------------------
  let editing = $state(false);
  let draft = $state('');
  let nameInput = $state<HTMLInputElement | null>(null);
  let nameBtn = $state<HTMLButtonElement | null>(null);
  async function startRename() {
    if (kind !== 'return') return;
    draft = name;
    editing = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }
  /** Leave the field: save (Enter, a click away) or cancel (Esc). Once only: the field's blur on removal is ignored. */
  async function endRename(save: boolean, refocus: boolean) {
    if (!editing) return;
    editing = false;
    // An unchanged name makes no undo entry; a refused one (empty, too long) keeps the old name.
    if (save && draft.trim() !== name && !renameReturn(p, target, draft)) flashHint(`A return's name is 1 to ${RETURN_NAME_MAX} characters`);
    if (!refocus) return;
    await tick();
    nameBtn?.focus();
  }
  function renameKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    void endRename(e.key === 'Enter', true);
  }

  // ---- sends (tracks) --------------------------------------------------------
  let sendsOpen = $state(false);
  /** The send level param's minimum: −∞ (Off). */
  const SEND_MIN = mixParam(sendParam(0)).min;
  /** How many of this track's sends (to existing returns) are above −∞. */
  const sendsOn = $derived(kind === 'track' ? p.mixer.returns.filter((r) => val(sendParam(r.slot)) > SEND_MIN).length : 0);

  // ---- sidechain -----------------------------------------------------------
  // Select values: "none", "t:<trackId>" (a whole track), "r:<trackId>:<row>".
  const enc = (k: SidechainKey | null) => (!k ? 'none' : k.row === null ? `t:${k.trackId}` : `r:${k.trackId}:${k.row}`);
  function dec(v: string): SidechainKey | null {
    if (v.startsWith('t:')) return { trackId: v.slice(2), row: null };
    if (v.startsWith('r:')) {
      const i = v.lastIndexOf(':');
      return { trackId: v.slice(2, i), row: Number(v.slice(i + 1)) };
    }
    return null;
  }
  const scLabel = $derived(kind === 'track' ? keyLabel(p, ch?.key ?? null) : 'none');
  const otherTracks = $derived(p.tracks.filter((t) => t.id !== target));
  const drumRows = $derived(
    p.tracks.flatMap((t) =>
      t.kind === 'drum'
        ? t.rows.map((_, row) => {
            const key = { trackId: t.id, row };
            return { value: enc(key), label: keyLabel(p, key), allowed: rowKeyAllowed(p, target, key) };
          })
        : [],
    ),
  );
  function pickKey(e: Event) {
    const sel = e.currentTarget as HTMLSelectElement;
    releaseSelect(sel); // give the keys back to the piano
    // pickSidechain: "none" on a ducked strip also switches its comp off (mixer-actions.ts).
    if (!pickSidechain(p, engine, target, dec(sel.value))) sel.value = enc(ch?.key ?? null); // refused: show the old key
  }

  // ---- gain reduction readouts (comp on tracks, limiter on master) ---------
  let grEl = $state<HTMLElement | null>(null);
  let shownGr = NaN;
  $effect(() => bus.on((m) => {
    if (!grEl) return false;
    const gr = m[channel * MIX_METER_STRIDE + 2] ?? 0;
    const r = Math.round(gr * 10) / 10;
    if (r === shownGr) return r > 0;
    shownGr = r;
    // Capped at 99.9 so the chip's fixed width (8ch, CSS below) always fits: a value never resizes the strip.
    grEl.textContent = r > 0 ? `−${Math.min(99.9, r).toFixed(1)} dB` : '0.0 dB';
    grEl.dataset.grDb = r.toFixed(1);
    return r > 0;
  }));

  // ---- ∿: show this strip in the mixer analyser ----------------------------
  // Scroll cue for the controls above the fader (.upper, no scrollbar): a
  // fade at the edge that has more content past it, so a short mixer shows
  // there is more to scroll to. Re-checked on scroll and on any size change
  // (a section opening, the window resizing).
  let upperEl = $state<HTMLElement | null>(null);
  let moreAbove = $state(false);
  let moreBelow = $state(false);
  function cue() {
    const u = upperEl;
    if (!u) return;
    moreAbove = u.scrollTop > 1;
    moreBelow = u.scrollTop + u.clientHeight < u.scrollHeight - 1;
  }
  $effect(() => {
    const u = upperEl;
    if (!u) return;
    const ro = new ResizeObserver(cue);
    ro.observe(u);
    for (const c of u.children) ro.observe(c);
    const mo = new MutationObserver(() => {
      for (const c of u.children) ro.observe(c);
      cue();
    });
    mo.observe(u, { childList: true });
    cue();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  });

  let analysed = $state(false);
  $effect(() => {
    if (kind === 'master') return;
    const ch = channel;
    return analyserBus().onSelect((s) => (analysed = s === ch));
  });

  const muted = $derived(val('mute') === 1);
  const soloed = $derived(val('solo') === 1);
  const fader = $derived(val('fader'));

  // ---- fader readout under automation --------------------------------------
  // While the fader's lane applies the readout shows the HEARD value (italic,
  // written straight into the DOM by the autoBus callback: no re-render per
  // frame); otherwise the fader's own value. The base is in the fader's title.
  const autoBus = useAutoBus();
  let faderOn = $state(false);
  let faderAuto: number | null = null;
  let faderAutoEl = $state<HTMLElement | null>(null);
  const paintReadout = () => {
    if (faderAutoEl && faderAuto !== null) faderAutoEl.textContent = formatDb(faderAuto);
  };
  $effect(() => {
    if (!autoBus) return;
    const owner = target;
    const off = untrack(() => autoBus.register(owner, { kind: 'mix', param: 'fader' }, (v) => {
      faderAuto = v.status === 'on' ? v.value : null;
      if ((faderAuto !== null) !== faderOn) faderOn = faderAuto !== null;
      paintReadout();
    }));
    return () => {
      off();
      faderAuto = null;
      untrack(() => (faderOn = false));
    };
  });
  $effect(() => {
    void faderAutoEl;
    paintReadout();
  });
</script>

<div
  class="strip mech-panel"
  class:sel={selected}
  class:neutral={color === null}
  style:--c={color ?? 'var(--raised)'}
  data-testid={kind === 'track' ? `strip-${channel}` : `strip-${target}`}
>
  <span class="screw" style:left="3px" style:top="42px"></span><span class="screw" style:right="3px" style:top="42px"></span>
  <span class="screw" style:left="3px" style:bottom="4px"></span><span class="screw" style:right="3px" style:bottom="4px"></span>
  {#if editing}
    <div class="name mech-head editing" data-testid="strip-name">
      <input
        class="rename"
        bind:this={nameInput}
        bind:value={draft}
        data-testid="return-name-input"
        aria-label={`New name for the ${name} return`}
        spellcheck="false"
        autocomplete="off"
        onkeydown={renameKey}
        onblur={() => void endRename(true, false)}
      />
      {#if subtitle}<span class="sub">{subtitle}</span>{/if}
    </div>
  {:else}
    <button
      type="button"
      class="name mech-head"
      data-testid="strip-name"
      bind:this={nameBtn}
      disabled={!onselect && kind !== 'return'}
      aria-pressed={onselect ? selected : undefined}
      title={onselect ? `${name} — click to select and edit it`
        : kind === 'return' ? `${name}${subtitle ? ` (${subtitle})` : ''} — double-click to rename`
        : `${name}${subtitle ? ` (${subtitle})` : ''}`}
      onclick={() => onselect?.()}
      ondblclick={() => void startRename()}
      onkeydown={(e) => { if (kind === 'return' && e.key === 'F2') { e.preventDefault(); void startRename(); } }}
    >
      <span class="nm">
        {#if ret}<span class="dot" style:--rc={returnColor(ret.slot)} data-testid="return-dot" aria-hidden="true"></span>{/if}
        <b>{name}</b>
      </span>
      {#if subtitle}<span class="sub">{subtitle}</span>{/if}
    </button>
  {/if}
  <span class="presets">
    <PopButton id="strip-presets-pop-{channel}" label={`${name} presets`} testid="strip-presets-pop" float>
      {#snippet trigger(a)}
        <button {...a} type="button" class="mech-btn pbtn" data-testid="strip-presets" aria-label={`Presets for ${name}`} title={presetsTitle}><Icon icon={SlidersHorizontal} size={12} /></button>
      {/snippet}
      {#snippet children(close)}
        <p class="lbl pop-h">{name} presets</p>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="plist" onkeydown={menuArrows}>
          {#each presets as pr (pr.id)}
            <button type="button" class="it" data-testid="preset-{pr.id}" title={pr.blurb} onclick={() => { close(); applyPreset(p, engine, target, pr.id); }}>{pr.name}</button>
          {/each}
          {#if canDuck}
            <hr />
            <button type="button" class="it" data-testid="preset-duck" title="Key the comp from the Kick row and pump this track with every kick" onclick={() => { close(); duck(); }}>Duck to kick</button>
          {/if}
          {#if kind === 'return'}
            <hr />
            <button type="button" class="it" data-testid="preset-delete-return" title={`Delete the ${name} return, every track's send to it and its lanes (Cmd/Ctrl+Z brings it all back)`} onclick={() => { close(); deleteReturn(p, engine, target); }}>Delete return</button>
          {/if}
        </div>
      {/snippet}
    </PopButton>
  </span>

  <!-- Everything above the fader: scrolls inside the strip when the mixer is too short for it, so the fader stays in view. -->
  <div class="upper" bind:this={upperEl} onscroll={cue} class:fade-top={moreAbove} class:fade-bot={moreBelow} data-testid="strip-upper">
  <!-- LED push-buttons: the LED (decoration) glows in the button's colour (--c on its column) while it is on. -->
  <div class="ms">
    {#if kind !== 'master'}
      <span class="lb m"><span class="led" class:lit={muted} aria-hidden="true"></span>
        <button type="button" class="mech-btn" aria-pressed={muted} aria-label={`Mute ${name}`} title={muted ? `${name} is muted — click to unmute` : `Mute ${name}`} data-testid="mute" onclick={() => toggleMute(p, engine, target)}>M</button></span>
    {/if}
    {#if kind === 'track'}
      <span class="lb s"><span class="led" class:lit={soloed} aria-hidden="true"></span>
        <button type="button" class="mech-btn" aria-pressed={soloed} aria-label={`Solo ${name}`} title={soloTitle(name, soloed, '; returns keep playing')} data-testid="solo" onclick={(e) => toggleSolo(p, engine, target, { additive: e.metaKey || e.ctrlKey || e.shiftKey })}>S</button></span>
    {/if}
    {#if kind !== 'master'}
      <span class="lb an"><span class="led" class:lit={analysed} aria-hidden="true"></span>
        <button type="button" class="mech-btn" aria-pressed={analysed} aria-label={`Show ${name} in analyser`} title="Show in analyser" data-testid={`analyser-strip-${channel}`} onclick={() => analyserBus().toggle(channel, target)}><Icon icon={Waveform} size={12} /></button></span>
    {/if}
  </div>

  <Section title="EQ" icon={Equalizer} {name} testid="eq" on={val('eq_on') === 1} ontoggle={() => set('eq_on', val('eq_on') ? 0 : 1)}>
    {#each eqKnobs as d (d.id)}
      <Knob variant="mech" size="sm" def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)} />
    {/each}
  </Section>

  {#if kind === 'track'}
    <Section title="Comp" icon={ArrowsInLineVertical} {name} testid="comp" on={val('comp_on') === 1} ontoggle={() => set('comp_on', val('comp_on') ? 0 : 1)}>
      {#snippet summary()}
        <span class="sc" data-testid="sc-label" title={`Sidechain (key) source: ${scLabel === 'none' ? 'none — the compressor listens to this track itself' : scLabel}`}>SC: {scLabel}</span>
        <span class="gr" class:dim={val('comp_on') !== 1} title="Compressor gain reduction">GR <span class="grn" bind:this={grEl} data-testid="gr" data-gr-db="0.0">0.0 dB</span></span>
      {/snippet}
      <label class="scpick">
        <span>Sidechain</span>
        <select data-testid="sc-select" value={enc(ch?.key ?? null)} onchange={pickKey} onkeydown={selectKey} aria-label={`${name} compressor sidechain source`}>
          <option value="none">none (this track)</option>
          {#if otherTracks.length}
            <optgroup label="Tracks">
              {#each otherTracks as t (t.id)}<option value={enc({ trackId: t.id, row: null })}>{t.name}</option>{/each}
            </optgroup>
          {/if}
          {#if drumRows.length}
            <optgroup label="Drum rows">
              {#each drumRows as r (r.value)}
                <option value={r.value} disabled={!r.allowed} title={r.allowed ? '' : `Max ${MAX_KEYS} drum-row sidechain keys`}>{r.label}{r.allowed ? '' : ` (max ${MAX_KEYS} keys)`}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </label>
      {#each compKnobs as d (d.id)}
        <Knob variant="mech" size="sm" def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)} />
      {/each}
    </Section>
  {/if}

  {#if fxKnobs.length}
    <Section title={retKind ? KIND_NAME[retKind] : ''} {name} testid="fx">
      {#each fxKnobs as d (d.id)}
        <!-- Synced delay times are clamped to 2 s by the engine: say so. -->
        <Knob variant="mech" size="sm" def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)}
          note={d.name === 'delay_time' ? delayClampNote(val(d.name), p.tempo) : ''} />
      {/each}
    </Section>
  {/if}

  {#if kind === 'track' && p.mixer.returns.length}
    <Section title="Sends" {name} testid="sends" aside={`${sendsOn} of ${p.mixer.returns.length}`} bind:open={sendsOpen}>
      {#snippet summary()}
        <!-- Closed = header + bars; open = the knob grid (the bars would repeat it). -->
        {#if !sendsOpen}<SendBars returns={p.mixer.returns} level={(slot) => val(sendParam(slot))} onopen={() => (sendsOpen = true)} />{/if}
      {/snippet}
      {#each p.mixer.returns as r (r.id)}
        {@const s = sendParam(r.slot)}
        {@const pre = sendPreParam(r.slot)}
        {@const isPre = val(pre) === 1}
        <!-- --c: the pre LED glows in the return's colour too. -->
        <div class="send" style:--c={returnColor(r.slot)}>
          <Knob variant="mech" size="sm" def={{ ...mixParam(s), label: r.name }} value={val(s)} color={returnColor(r.slot)} moduleName={`${name} send to`} testid={`knob-${s}`} auto={autoOf(s)} onchange={(v) => set(s, v)} />
          <button type="button" class="pre mech-btn" aria-pressed={isPre} aria-label={`${name} ${r.name} send pre-fader`} title={isPre ? 'Pre-fader: the send ignores this fader — click for post-fader' : 'Post-fader: the send follows this fader — click for pre-fader'} data-testid={`${s}-pre`} onclick={() => set(pre, isPre ? 0 : 1)}><span class="led" class:lit={isPre} aria-hidden="true"></span>{isPre ? 'pre' : 'post'}</button>
        </div>
      {/each}
    </Section>
  {/if}

  {#if kind !== 'master'}
    <div class="row">
      <Knob variant="mech" size="sm" def={mixParam('pan')} value={val('pan')} color={knobColor} moduleName={name} testid="knob-pan" auto={autoOf('pan')} onchange={(v) => set('pan', v)} />
    </div>
  {:else}
    <div class="row limiter" title="Master limiter: the output never exceeds the ceiling">
      <Knob variant="mech" size="sm" def={mixParam('limiter_ceiling')} value={val('limiter_ceiling')} color={knobColor} moduleName="Master limiter" testid="knob-limiter_ceiling" auto={autoOf('limiter_ceiling')} onchange={(v) => set('limiter_ceiling', v)} />
      <div class="grbox" title="Limiter gain reduction: how much the master is being turned down to stay under the ceiling">
        <span class="engr">Lim GR</span>
        <span class="grv" bind:this={grEl} data-testid="gr" data-gr-db="0.0">0.0 dB</span>
      </div>
    </div>
  {/if}
  </div>

  <div class="fm">
    <Fader value={fader} name={`${name} volume`} auto={autoOf('fader')} onchange={(v) => set('fader', v)} />
    <div class="scale" aria-hidden="true">
      {#each SCALE_TICKS as db (db)}
        <span style:bottom="calc({faderPos(db) * 100}% - 5px)">{db === SCALE_TICKS[0] ? '−∞' : db > 0 ? `+${db}` : db < 0 ? `−${-db}` : '0'}</span>
      {/each}
    </div>
    <div class="mtr"><Meter {bus} {channel} {name} {ceilingDb} master={kind === 'master'} /></div>
  </div>
  <div class="readout" class:auto={faderOn} data-testid="fader-readout" data-auto={faderOn ? 'on' : undefined}
    title={faderOn ? `${name} volume, automated (base ${formatDb(fader)})` : `${name} volume`}
  >{#if faderOn}<span bind:this={faderAutoEl}></span>{:else}{formatDb(fader)}{/if}</div>
</div>

<style>
  /* The faceplate (spec §11; .mech-panel / .mech-head / .screw in theme.css):
     the gradient panel, a 36 px header strip in the track colour (--c), four
     corner screws, a track-colour outline when selected. 132 px wide: two
     compact (46 px) mech knobs per row fit the 112 px inside. */
  .strip { position: relative; width: 132px; max-height: 100%; flex: none; display: flex; flex-direction: column; padding: 0 10px 12px; box-sizing: border-box; overflow: hidden; }
  /* The controls above the fader shrink first: in a short mixer they scroll
     (wheel, or the focus moving into them) and the fader, the dB scale, the
     meter and the readout stay in view. No scrollbar: a classic one would
     take ~11 px of the 112 px the two-knob rows need. */
  .upper { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden auto; scrollbar-width: none; }
  /* The scroll cue: 14 px fades where more content is (the script's cue()). */
  .upper.fade-top { mask-image: linear-gradient(to bottom, transparent, black 14px); }
  .upper.fade-bot { mask-image: linear-gradient(to top, transparent, black 14px); }
  .upper.fade-top.fade-bot { mask-image: linear-gradient(to bottom, transparent, black 14px, black calc(100% - 14px), transparent); }
  .fm, .readout { flex: none; }
  /* Selected: a 2 px ring in --c over the faceplate, header included (::after, above the screws and Presets). */
  .strip.sel::after { content: ''; position: absolute; inset: 0; z-index: 3; border-radius: inherit; box-shadow: inset 0 0 0 2px var(--c); pointer-events: none; }
  .screw { z-index: 1; }
  /* Right padding: room for the Presets button over the header's right end. */
  .name { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; height: 36px; flex: none; box-sizing: border-box; border: 0; margin: 0 -10px 4px; padding: 0 34px 0 12px; text-align: left; cursor: pointer; min-width: 0; }
  /* Presets: a small push-button on the header's right end (over the name
     button, a sibling: a button can't hold one), and its menu rows in
     MenuBar's item look (a full-width band per item). */
  .presets { position: absolute; top: 7px; right: 8px; z-index: 2; }
  .pbtn { min-width: 22px; width: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .pop-h { margin: 0 8px; }
  .plist { display: flex; flex-direction: column; gap: 1px; min-width: 150px; }
  .it {
    display: flex; align-items: center; width: 100%; box-sizing: border-box; min-height: 26px; padding: 0 8px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); text-align: left; white-space: nowrap; cursor: pointer;
  }
  .it:hover { background: var(--raised); }
  .it:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  .plist hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--line); }
  .name:disabled { cursor: default; }
  .name:not(:disabled):hover { filter: brightness(1.06); }
  /* A return's name row: its colour dot (an 8 px circle: geometry) before the name. */
  .nm { display: flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--rc); box-shadow: 0 0 0 1px var(--mech-recess), 0 0 5px color-mix(in srgb, var(--rc) 55%, transparent); }
  /* Renaming a return: the name becomes a recessed field, the subtitle stays. */
  .name.editing { cursor: default; }
  .rename { width: 100%; box-sizing: border-box; height: 16px; padding: 0 4px; border: 0; border-radius: var(--r-xs); background: var(--mech-recess); box-shadow: var(--mech-chip-shadow); color: var(--text); font: 700 var(--fs-lbl) var(--font-ui); }
  .rename:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--mech-chip-shadow); }
  .name b { font-size: var(--fs-lbl); line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .sub { font: 600 var(--fs-xs)/12px var(--font-ui); letter-spacing: 0.04em; text-transform: none; opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  /* Returns and master sit on --raised: light text at full opacity (dark text and the dimmed subtitle lack contrast there). */
  .neutral .name { color: var(--text); }
  .neutral .sub { opacity: 1; }
  .name:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--mech-head-shadow); }
  /* M / S / ∿: LED-over-button columns, centred (clear of the screws). The LED's colour per button. */
  .ms { display: flex; justify-content: center; gap: 6px; padding: 0 0 4px; }
  .lb { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .lb.m { --c: var(--sig-cv); }
  .lb.s { --c: var(--track-7); }
  .lb.an { --c: var(--play); }
  .ms .mech-btn { min-width: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-lbl); }
  .sc { display: block; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .gr { display: block; color: var(--text-2); font: var(--fs-lbl) var(--font-mono); }
  .gr.dim { opacity: 0.5; }
  /* GR readouts: fixed width for the widest text ("−99.9 dB", 8ch) so a changing value never resizes the strip. */
  .grn, .grv { display: inline-block; min-width: 8ch; text-align: center; font-variant-numeric: tabular-nums; box-sizing: content-box; }
  .scpick { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 1px; width: 100%; font-size: var(--fs-lbl); color: var(--text-2); }
  .scpick select { width: 100%; }
  /* A row under an engraved divider (--mech-divider). */
  .row { display: flex; flex-direction: column; align-items: center; gap: 4px; box-shadow: var(--mech-divider); padding-top: 5px; margin-top: 1px; }
  /* Sends: a cell per return in the Section's two-column grid, the knob over its pre/post button (--c: the return's colour, for the LED). */
  .send { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; max-width: 100%; }
  .pre { display: inline-flex; align-items: center; gap: 3px; min-width: 0; height: 16px; padding: 0 5px; font-size: var(--fs-xs); }
  .pre .led { width: 5px; height: 5px; }
  /* Master: the limiter's ceiling knob beside its GR readout. */
  .limiter { flex-direction: row; justify-content: center; }
  .grbox { display: flex; flex-direction: column; align-items: center; gap: 3px; white-space: nowrap; }
  .grv { font: var(--fs-lbl)/14px var(--font-mono); color: var(--accent); background: var(--mech-recess); box-shadow: var(--mech-chip-shadow); border-radius: var(--r-xs); padding: 1px 5px; }
  .fm { display: flex; justify-content: center; gap: 3px; box-shadow: var(--mech-divider); padding-top: 6px; margin-top: 2px; height: 132px; }
  .scale { position: relative; width: 20px; margin: 8px 0; }
  .scale span { position: absolute; right: 0; font: var(--fs-xs)/10px var(--font-mono); color: var(--mech-label); text-shadow: var(--mech-label-shadow); }
  /* Bottom padding = the fader cap's half height: meter 0 lines up with −∞. */
  .mtr { height: 100%; padding-bottom: 8px; box-sizing: border-box; }
  /* The value chip (--mech-recess), as under the rack's controls. */
  .readout { margin-top: 4px; align-self: center; font: var(--fs-ctl)/1.4 var(--font-mono); color: var(--mech-chip-text); background: var(--mech-recess); box-shadow: var(--mech-chip-shadow); border-radius: var(--r-xs); padding: 0 6px; min-width: 60px; text-align: center; }
  .readout.auto { font-style: italic; color: var(--accent); }
</style>
