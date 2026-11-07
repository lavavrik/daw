<script lang="ts">
  // One mixer strip: a track, a return (Reverb / Delay) or the Master.
  // Top to bottom (anti-goal: never guess what a control is or what it is set
  // to — every control is labelled and shows its value):
  //   name (track colour; click selects the track) · M / S ·
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

  const NEUTRAL = '#9aa6c4';
  const knobColor = $derived(color ?? NEUTRAL);
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
    if (!grEl) return;
    const gr = m[channel * MIX_METER_STRIDE + 2] ?? 0;
    const r = Math.round(gr * 10) / 10;
    if (r === shownGr) return;
    shownGr = r;
    grEl.textContent = r > 0 ? `−${r.toFixed(1)} dB` : '0.0 dB';
    grEl.dataset.grDb = r.toFixed(1);
  }));

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
  style:--c={color ?? '#6b7080'}
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
  </div>

  <Section title="EQ" {name} testid="eq" on={val('eq_on') === 1} ontoggle={() => set('eq_on', val('eq_on') ? 0 : 1)}>
    {#each eqKnobs as d (d.id)}
      <Knob def={d} value={val(d.name)} color={knobColor} moduleName={name} testid={`knob-${d.name}`} auto={autoOf(d.name)} onchange={(v) => set(d.name, v)} />
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
          <Knob def={mixParam(s)} value={val(s)} color={knobColor} moduleName={`${name} send to`} testid={`knob-${s}`} auto={autoOf(s)} onchange={(v) => set(s, v)} />
          <button type="button" class="pre" class:lit={isPre} aria-pressed={isPre} aria-label={`${name} ${mixParam(s).label} send pre-fader`} title={isPre ? 'Pre-fader: the send ignores this fader — click for post-fader' : 'Post-fader: the send follows this fader — click for pre-fader'} data-testid={`${s}-pre`} onclick={() => set(pre, isPre ? 0 : 1)}>{isPre ? 'pre' : 'post'}</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if kind !== 'master'}
    <div class="row">
      <Knob def={mixParam('pan')} value={val('pan')} color={knobColor} moduleName={name} testid="knob-pan" auto={autoOf('pan')} onchange={(v) => set('pan', v)} />
    </div>
  {:else}
    <div class="row limiter" title="Master limiter: the output never exceeds the ceiling">
      <Knob def={mixParam('limiter_ceiling')} value={val('limiter_ceiling')} color={knobColor} moduleName="Master limiter" testid="knob-limiter_ceiling" auto={autoOf('limiter_ceiling')} onchange={(v) => set('limiter_ceiling', v)} />
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
  .strip { width: 118px; flex: none; display: flex; flex-direction: column; background: #1f2026; border: 1px solid #2a2c33; border-top: 3px solid var(--c); border-radius: 3px; padding: 0 3px 4px; box-sizing: border-box; }
  .strip.sel { background: #282a33; box-shadow: inset 0 0 0 1px #4a4f63; }
  .strip.neutral { background: #1c1d22; }
  .name { display: flex; flex-direction: column; align-items: flex-start; border: 0; background: transparent; padding: 3px 2px; font: inherit; text-align: left; cursor: pointer; border-radius: 2px; min-width: 0; }
  .name:disabled { cursor: default; }
  .name:not(:disabled):hover { background: #2c2e37; }
  .name b { color: var(--c); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .neutral .name b { color: #e6e7ec; }
  .sub { font-size: 10px; color: #8d90a0; }
  .name:focus-visible { outline: 1px solid #f0a23a; }
  .ms { display: flex; gap: 3px; padding: 2px 2px 4px; min-height: 20px; }
  .ms button { width: 26px; height: 18px; font: 600 11px ui-sans-serif, system-ui, sans-serif; border: 1px solid #3a3d47; border-radius: 3px; background: #2a2c33; color: #c9cbd3; cursor: pointer; }
  .ms .m.lit { background: #4dabf7; border-color: #4dabf7; color: #111; }
  .ms .s.lit { background: #ffd43b; border-color: #ffd43b; color: #111; }
  .ms button:focus-visible { outline: 1px solid #f0a23a; }
  .sc { display: block; overflow: hidden; text-overflow: ellipsis; color: #d7d9e0; }
  .gr { display: block; color: #a3a6b3; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .gr.dim { opacity: 0.5; }
  .scpick { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 1px; width: 100%; font-size: 10px; color: #a3a6b3; }
  .scpick select { font: 11px ui-sans-serif, system-ui, sans-serif; background: #15161a; color: #e6e7ec; border: 1px solid #3a3d47; border-radius: 3px; padding: 1px; width: 100%; }
  .row { display: flex; justify-content: center; border-top: 1px solid #2a2c33; padding-top: 2px; }
  .sends { justify-content: space-between; }
  .send { display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .pre { font: 9px ui-sans-serif, system-ui, sans-serif; border: 1px solid #3a3d47; border-radius: 3px; background: #1a1b20; color: #8d90a0; padding: 0 4px; cursor: pointer; }
  .pre.lit { background: #9775fa; border-color: #9775fa; color: #111; }
  .limiter { flex-direction: column; align-items: center; gap: 2px; padding-bottom: 2px; }
  .grbox { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #a3a6b3; white-space: nowrap; }
  .grv { font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: #ffd98a; background: #15161a; border-radius: 2px; padding: 0 3px; }
  .fm { display: flex; justify-content: center; gap: 3px; border-top: 1px solid #2a2c33; padding-top: 6px; height: 132px; }
  .scale { position: relative; width: 20px; margin: 9px 0; }
  .scale span { position: absolute; right: 0; font: 9px/10px ui-monospace, SFMono-Regular, Menlo, monospace; color: #7d808c; }
  /* Bottom padding = the fader cap's half height: meter 0 lines up with −∞. */
  .mtr { height: 100%; padding-bottom: 9px; box-sizing: border-box; }
  .readout.auto { font-style: italic; color: #f0a23a; }
  .readout { margin-top: 3px; align-self: center; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e6e7ec; background: #15161a; border-radius: 2px; padding: 0 5px; min-width: 56px; text-align: center; }
</style>
