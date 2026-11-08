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
  //   Reverb / Delay settings (returns) · sends "Reverb" / "Delay" with pre
  //   toggles (tracks) · Pan · Limiter ceiling + GR (master) ·
  //   fader | dB scale | stereo meter · fader readout.
  // All edits go through mixer-actions.ts (state + engine command); knobs and
  // the fader coalesce their sends to one per animation frame. Every
  // continuous knob and the fader follow their automation lane (`auto`,
  // plan 10 Task 4) and offer "Automate" on right-click.
  import type { AudioEngine } from '../../audio/engine';
  import { MIX_PARAMS, mixParam } from '../../audio/mixerCatalog';
  import type { MixParamDef, MixTarget } from '../../audio/mixerCatalog';
  import { MAX_KEYS, MIX_METER_STRIDE } from '../../audio/protocol';
  import type { ChannelState, Project, SidechainKey } from '../../state/project.svelte';
  import { keyLabel, rowKeyAllowed, setMix, setSidechain, toggleMute, toggleSolo } from '../../state/mixer-actions';
  import type { MixChannelTarget } from '../../state/mixer-actions';
  import Knob from '../rack/Knob.svelte';
  import Fader from './Fader.svelte';
  import Meter from './Meter.svelte';
  import Section from './Section.svelte';
  import { untrack } from 'svelte';
  import { useAutoBus } from '../autoBus';
  import type { MeterBus } from './meterBus';
  import { SCALE_TICKS, delayClampNote, faderPos, formatDb } from './mixMath';
  import { analyserBus } from '../vis/analyserBus';

  let { p, engine, bus, target, kind, channel, name, color = null, subtitle = '', selected = false, onselect }: {
    p: Project;
    engine: AudioEngine;
    bus: MeterBus;
    /** Track id, or 'reverb' / 'delay' / 'master'. */
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

  /** The strip colour: the track's, or a neutral for returns and the master. */
  const knobColor = $derived(color ?? 'var(--text-dim)');
  const ch = $derived<ChannelState | undefined>(
    kind === 'track' ? p.mixer.channels[target] : p.mixer[target as 'reverb' | 'delay' | 'master'],
  );
  const val = (n: string) => ch?.params[mixParam(n).id] ?? mixParam(n).default;
  const set = (n: string, v: number) => setMix(p, engine, target, n, v);
  /** The lane target of mixer param `n` on this channel (Knob / Fader follow it: ui/autoBus.ts). */
  const autoOf = (n: string) => ({ owner: target, target: { kind: 'mix' as const, param: n } });

  const group = (g: string): MixParamDef[] => MIX_PARAMS.filter((d) => d.group === g && d.appliesTo.includes(kind));
  const eqKnobs = $derived(group('eq').filter((d) => d.name !== 'eq_on'));
  const compKnobs = $derived(group('comp').filter((d) => d.name !== 'comp_on'));
  const fxKnobs = $derived(target === 'reverb' ? group('reverb') : target === 'delay' ? group('delay') : []);
  const ceilingDb = $derived(kind === 'master' ? val('limiter_ceiling') : 0);

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
    if (!setSidechain(p, engine, target, dec(sel.value))) sel.value = enc(ch?.key ?? null); // refused: show the old key
  }
  /** A focused <select> type-aheads on letters: the piano keys must not change the key. */
  function selectKey(e: KeyboardEvent) {
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
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
    grEl.textContent = r > 0 ? `−${r.toFixed(1)} dB` : '0.0 dB';
    grEl.dataset.grDb = r.toFixed(1);
    return r > 0;
  }));

  // ---- ∿: show this strip in the mixer analyser ----------------------------
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
  class="strip"
  class:sel={selected}
  class:neutral={color === null}
  style:--c={color ?? 'var(--raised)'}
  data-testid={kind === 'track' ? `strip-${channel}` : `strip-${target}`}
>
  <button
    type="button"
    class="name"
    data-testid="strip-name"
    disabled={!onselect}
    aria-pressed={onselect ? selected : undefined}
    title={onselect ? `${name} — click to select and edit it` : `${name}${subtitle ? ` (${subtitle})` : ''}`}
    onclick={() => onselect?.()}
  >
    <b>{name}</b>
    {#if subtitle}<span class="sub">{subtitle}</span>{/if}
  </button>

  <div class="ms">
    {#if kind !== 'master'}
      <button type="button" class="m" class:lit={muted} aria-pressed={muted} aria-label={`Mute ${name}`} title={muted ? `${name} is muted — click to unmute` : `Mute ${name}`} data-testid="mute" onclick={() => toggleMute(p, engine, target)}>M</button>
    {/if}
    {#if kind === 'track'}
      <button type="button" class="s" class:lit={soloed} aria-pressed={soloed} aria-label={`Solo ${name}`} title={soloed ? `${name} is soloed — click to unsolo` : `Solo ${name} (other tracks are muted; returns keep playing)`} data-testid="solo" onclick={() => toggleSolo(p, engine, target)}>S</button>
    {/if}
    {#if kind !== 'master'}
      <button type="button" class="an" class:lit={analysed} aria-pressed={analysed} aria-label={`Show ${name} in analyser`} title="Show in analyser" data-testid={`analyser-strip-${channel}`} onclick={() => analyserBus().toggle(channel, target)}>∿</button>
    {/if}
  </div>

  <Section title="EQ" {name} testid="eq" on={val('eq_on') === 1} ontoggle={() => set('eq_on', val('eq_on') ? 0 : 1)}>
    {#each eqKnobs as d (d.id)}
      <Knob variant="slider" def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)} />
    {/each}
  </Section>

  {#if kind === 'track'}
    <Section title="Comp" {name} testid="comp" on={val('comp_on') === 1} ontoggle={() => set('comp_on', val('comp_on') ? 0 : 1)}>
      {#snippet summary()}
        <span class="sc" data-testid="sc-label" title={`Sidechain (key) source: ${scLabel === 'none' ? 'none — the compressor listens to this track itself' : scLabel}`}>SC: {scLabel}</span>
        <span class="gr" class:dim={val('comp_on') !== 1} title="Compressor gain reduction">GR <span bind:this={grEl} data-testid="gr" data-gr-db="0.0">0.0 dB</span></span>
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
        <Knob def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)} />
      {/each}
    </Section>
  {/if}

  {#if fxKnobs.length}
    <Section title={target === 'reverb' ? 'Reverb' : 'Delay'} {name} testid="fx">
      {#each fxKnobs as d (d.id)}
        <!-- Synced delay times are clamped to 2 s by the engine: say so. -->
        <Knob def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)}
          note={d.name === 'delay_time' ? delayClampNote(val(d.name), p.tempo) : ''} />
      {/each}
    </Section>
  {/if}

  {#if kind === 'track'}
    <div class="row sends" title="Sends: how much of this track goes to the Reverb and Delay returns">
      {#each [['send_a', 'send_a_pre'], ['send_b', 'send_b_pre']] as [s, pre] (s)}
        {@const isPre = val(pre) === 1}
        <div class="send">
          <Knob variant="slider" def={mixParam(s)} value={val(s)} color={knobColor} moduleName={`${name} send to`} testid={`knob-${s}`} auto={autoOf(s)} onchange={(v) => set(s, v)} />
          <button type="button" class="pre" class:lit={isPre} aria-pressed={isPre} aria-label={`${name} ${mixParam(s).label} send pre-fader`} title={isPre ? 'Pre-fader: the send ignores this fader — click for post-fader' : 'Post-fader: the send follows this fader — click for pre-fader'} data-testid={`${s}-pre`} onclick={() => set(pre, isPre ? 0 : 1)}>{isPre ? 'pre' : 'post'}</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if kind !== 'master'}
    <div class="row">
      <Knob variant="slider" def={mixParam('pan')} value={val('pan')} color={knobColor} moduleName={name} testid="knob-pan" auto={autoOf('pan')} onchange={(v) => set('pan', v)} />
    </div>
  {:else}
    <div class="row limiter" title="Master limiter: the output never exceeds the ceiling">
      <Knob variant="slider" def={mixParam('limiter_ceiling')} value={val('limiter_ceiling')} color={knobColor} moduleName="Master limiter" testid="knob-limiter_ceiling" auto={autoOf('limiter_ceiling')} onchange={(v) => set('limiter_ceiling', v)} />
      <div class="grbox" title="Limiter gain reduction: how much the master is being turned down to stay under the ceiling">
        <span>Limiter GR</span>
        <span class="grv" bind:this={grEl} data-testid="gr" data-gr-db="0.0">0.0 dB</span>
      </div>
    </div>
  {/if}

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
  /* A card (spec §4): --panel body with --lift, a track-colour header with
     --gloss, a track-colour outline when selected. 132 px wide: the slider
     variant needs ~112 px, so the strips stay compact. */
  .strip { width: 132px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-radius: var(--r-lg); box-shadow: var(--lift); padding: 0 8px 8px; box-sizing: border-box; overflow: hidden; }
  .strip.sel { outline: 2px solid var(--c); outline-offset: -1px; }
  .name { display: flex; flex-direction: column; align-items: flex-start; border: 0; background: var(--c) var(--gloss); color: var(--on-color); margin: 0 -8px 6px; padding: 5px 10px 4px; font: inherit; text-align: left; cursor: pointer; min-width: 0; }
  .name:disabled { cursor: default; }
  .name:not(:disabled):hover { filter: brightness(1.06); }
  .name b { font-size: var(--fs-ctl); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .sub { font-size: var(--fs-lbl); opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  /* Returns and master sit on --raised: light text at full opacity (dark text and the dimmed subtitle lack contrast there). */
  .neutral .name { color: var(--text); }
  .neutral .sub { opacity: 1; }
  .name:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .ms { display: flex; gap: 3px; padding: 2px 0 4px; min-height: 22px; }
  .ms button { width: 26px; height: 20px; font: 700 var(--fs-lbl) var(--font-ui); border: 0; border-radius: var(--r-sm); background: var(--raised); color: var(--text); cursor: pointer; box-shadow: var(--raised-shadow); }
  .ms .m.lit { background: var(--sig-cv) var(--gloss); color: var(--on-color); }
  .ms .s.lit { background: var(--track-7) var(--gloss); color: var(--on-color); }
  .ms .an { margin-left: auto; font-size: 13px; line-height: 1; }
  .ms .an.lit { background: var(--play) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--play) 40%, transparent); }
  .ms button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .sc { display: block; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .gr { display: block; color: var(--text-2); font: var(--fs-lbl) var(--font-mono); }
  .gr.dim { opacity: 0.5; }
  .scpick { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 1px; width: 100%; font-size: var(--fs-lbl); color: var(--text-2); }
  .scpick select { width: 100%; }
  .row { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line); padding-top: 4px; margin-top: 2px; }
  /* A send: its slider, then the pre/post toggle under it, aligned right. */
  .sends { gap: 2px; }
  .send { display: flex; flex-direction: column; align-items: stretch; gap: 1px; }
  .pre { align-self: flex-end; font: 600 9px var(--font-ui); border: 0; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow); color: var(--text-2); padding: 0 6px; cursor: pointer; }
  .pre.lit { background: var(--sig-vel) var(--gloss); color: var(--on-color); box-shadow: var(--raised-shadow); }
  .pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .grbox { display: flex; align-items: center; gap: 4px; font-size: var(--fs-lbl); color: var(--text-2); white-space: nowrap; }
  .grv { font: var(--fs-lbl)/1.3 var(--font-mono); color: var(--accent); background: var(--well); border-radius: var(--r-sm); padding: 0 4px; }
  .fm { display: flex; justify-content: center; gap: 3px; border-top: 1px solid var(--line); padding-top: 6px; margin-top: 4px; height: 132px; }
  .scale { position: relative; width: 20px; margin: 9px 0; }
  .scale span { position: absolute; right: 0; font: 9px/10px var(--font-mono); color: var(--text-2); }
  /* Bottom padding = the fader cap's half height: meter 0 lines up with −∞. */
  .mtr { height: 100%; padding-bottom: 9px; box-sizing: border-box; }
  .readout { margin-top: 4px; align-self: center; font: var(--fs-ctl)/1.4 var(--font-mono); color: var(--text); background: var(--lcd); box-shadow: var(--well-shadow); border-radius: var(--r-sm); padding: 0 6px; min-width: 60px; text-align: center; }
  .readout.auto { font-style: italic; color: var(--accent); }
</style>
