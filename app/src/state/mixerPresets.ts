// Mixer strip presets (plan 27 Task 1; spec 2026-11-19-builtin-content.md
// §3): the tables behind each strip's Presets menu, and applyPreset.
//
// A preset is data: a strip kind and absolute values for whole sections of
// that strip (a track preset: EQ, comp and both sends with their pre flags;
// a return preset: its EQ and its effect; a master preset: its EQ and the
// limiter). Whole sections, so presets are absolute: applying one after
// another never leaves a knob of the first one behind. A preset never holds
// fader, pan, mute or solo (the mix balance is the user's). Every value is
// inside the mixer_catalog.json range (mixerPresets.test.ts checks every
// one).
//
// A KEYED track strip (a sidechain key: Duck to kick, or a key picked by
// hand) is a comp the user set up on purpose, so applyPreset treats it
// specially (plan 27 Task 1 review, ruling 1):
//   - a track preset other than Flat leaves the comp section alone (the duck
//     survives) and applies only its EQ and sends;
//   - Flat clears the key and turns the comp off, in the same edit: Flat
//     means a clean strip.
//
// Why each value: docs/architecture/mixer.md "Strip presets" (the table).
// The EQ the values talk to (engine/src/dsp/eq.rs): HP 12 dB/oct (20 Hz =
// off), low shelf at 100 Hz, a mid peak, high shelf at 8 kHz.
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import type { CommandSink } from './actions';
import { edit } from './edits';
import { setMix, setSidechain } from './mixer-actions';
import type { MixChannelTarget } from './mixer-actions';
import type { Project } from './project.svelte';

/** Which strips a preset is for (the two returns differ: each has its own effect). */
export type PresetKind = 'track' | 'reverb' | 'delay' | 'master';

export interface MixPreset {
  /** Stable id (templates and tests name presets by it). */
  id: string;
  /** The menu item, and the undo label "Preset: <name>". */
  name: string;
  kind: PresetKind;
  /** One line for the menu item's tooltip. */
  blurb: string;
  /** Mixer param name -> value, in catalog units (dB, Hz, ms, s, a choice index). */
  params: Readonly<Record<string, number>>;
}

/** The catalog defaults of the params in `groups` (Flat, and every preset's base). */
function defaults(...groups: string[]): Record<string, number> {
  return Object.fromEntries(MIX_PARAMS.filter((d) => groups.includes(d.group)).map((d) => [d.name, d.default]));
}
const TRACK_BASE = defaults('eq', 'comp', 'send');
const REVERB_BASE = defaults('eq', 'reverb');
const DELAY_BASE = defaults('eq', 'delay');
const MASTER_BASE = defaults('eq', 'limiter');
/** A Delay division by its label ("3/16"), as the catalog's choice index. */
const division = (label: string) => mixParam('delay_time').choices.indexOf(label);

const track = (id: string, name: string, blurb: string, params: Record<string, number>): MixPreset =>
  ({ id, name, kind: 'track', blurb, params: { ...TRACK_BASE, ...params } });

export const MIX_PRESETS: readonly MixPreset[] = [
  // ---- tracks ---------------------------------------------------------------
  track('kick-punch', 'Kick punch', 'Weight at 100 Hz, less box, a slow-attack comp that lets the click through; dry', {
    eq_on: 1, eq_hp: 30, eq_low: 3, eq_mid_freq: 400, eq_mid_gain: -3, eq_mid_q: 1.2, eq_high: 1.5,
    comp_on: 1, comp_threshold: -14, comp_ratio: 4, comp_attack: 10, comp_release: 80, comp_makeup: 3,
  }),
  track('bass-tidy', 'Bass tidy', 'Sub rumble and mud cut, the very top softened, an even level; dry', {
    eq_on: 1, eq_hp: 30, eq_low: 0, eq_mid_freq: 250, eq_mid_gain: -3, eq_mid_q: 1, eq_high: -3,
    comp_on: 1, comp_threshold: -20, comp_ratio: 4, comp_attack: 15, comp_release: 120, comp_makeup: 3,
  }),
  track('hats-air', 'Hats air', 'For a hats or percussion track: everything under 300 Hz out (removes the kick on a full-kit strip), harshness down, air up; a touch of room', {
    eq_on: 1, eq_hp: 300, eq_low: 0, eq_mid_freq: 3500, eq_mid_gain: -2, eq_mid_q: 1.5, eq_high: 3,
    send_a: -22,
  }),
  track('pad-wash', 'Pad wash', 'Out of the kick and bass range, softened, gently levelled, washed in reverb', {
    eq_on: 1, eq_hp: 180, eq_low: 0, eq_mid_freq: 500, eq_mid_gain: -3, eq_mid_q: 0.8, eq_high: -2,
    comp_on: 1, comp_threshold: -24, comp_ratio: 2, comp_attack: 30, comp_release: 300, comp_makeup: 2,
    send_a: -8, send_b: -24,
  }),
  track('stab-space', 'Stab space', 'Low end out, presence up, punchy comp, reverb plus a dub echo', {
    eq_on: 1, eq_hp: 150, eq_low: 0, eq_mid_freq: 2500, eq_mid_gain: 2, eq_mid_q: 1, eq_high: 0,
    comp_on: 1, comp_threshold: -18, comp_ratio: 3, comp_attack: 5, comp_release: 100, comp_makeup: 2,
    send_a: -14, send_b: -16,
  }),
  track('lead-presence', 'Lead presence', 'Low end out, 3 kHz a little forward, a little air, steady level, some space', {
    eq_on: 1, eq_hp: 120, eq_low: 0, eq_mid_freq: 3000, eq_mid_gain: 2, eq_mid_q: 1.2, eq_high: 1.5,
    comp_on: 1, comp_threshold: -18, comp_ratio: 3, comp_attack: 8, comp_release: 150, comp_makeup: 2,
    send_a: -16, send_b: -18,
  }),
  track('flat', 'Flat', 'EQ, comp and sends back to their defaults (off)', {}),

  // ---- the Reverb return ----------------------------------------------------
  // Every reverb preset high-passes the return: reverb on low end is mud.
  { id: 'room', name: 'Room', kind: 'reverb', blurb: 'Small and short (0.8 s): ambience that thickens without a tail',
    params: { ...REVERB_BASE, eq_on: 1, eq_hp: 250, rev_size: 0.35, rev_decay: 0.8, rev_damping: 0.5, rev_predelay: 10 } },
  { id: 'plate', name: 'Plate', kind: 'reverb', blurb: 'Bright and dense, 1.8 s: the vocal and snare classic',
    params: { ...REVERB_BASE, eq_on: 1, eq_hp: 300, rev_size: 0.55, rev_decay: 1.8, rev_damping: 0.25, rev_predelay: 25 } },
  { id: 'hall', name: 'Hall', kind: 'reverb', blurb: 'Big, 3.8 s, 40 ms predelay: breakdowns and pads',
    params: { ...REVERB_BASE, eq_on: 1, eq_hp: 250, rev_size: 0.85, rev_decay: 3.8, rev_damping: 0.45, rev_predelay: 40 } },
  { id: 'dark', name: 'Dark', kind: 'reverb', blurb: 'Heavily damped, top shelved off: deep-house space that stays behind',
    params: { ...REVERB_BASE, eq_on: 1, eq_hp: 200, eq_high: -6, rev_size: 0.7, rev_decay: 2.8, rev_damping: 0.85, rev_predelay: 20 } },

  // ---- the Delay return -----------------------------------------------------
  { id: 'delay-pingpong', name: '1/8 ping-pong', kind: 'delay', blurb: 'Eighths bouncing left-right, a few repeats',
    params: { ...DELAY_BASE, eq_on: 1, eq_hp: 300, delay_time: division('1/8'), delay_feedback: 0.35, delay_ping_pong: 1, delay_high_cut: 6000 } },
  { id: 'delay-dub', name: '3/16 dub', kind: 'delay', blurb: 'Dotted-eighth echo, long and dark, in the middle',
    params: { ...DELAY_BASE, eq_on: 1, eq_hp: 400, eq_mid_freq: 800, eq_mid_gain: 2, delay_time: division('3/16'), delay_feedback: 0.55, delay_ping_pong: 0, delay_high_cut: 2500 } },
  { id: 'delay-slap', name: '1/4 slap', kind: 'delay', blurb: 'A single soft repeat one beat (a quarter note) later, then gone',
    params: { ...DELAY_BASE, eq_on: 1, eq_hp: 250, delay_time: division('1/4'), delay_feedback: 0.15, delay_ping_pong: 0, delay_high_cut: 5000 } },

  // ---- the master -----------------------------------------------------------
  { id: 'master-clean', name: 'Clean', kind: 'master', blurb: 'No EQ, limiter at −0.3 dB',
    params: { ...MASTER_BASE, limiter_ceiling: -0.3 } },
  { id: 'master-warm', name: 'Warm', kind: 'master', blurb: 'Sub rumble out, a little low lift, top and harshness eased; limiter at −0.3 dB',
    params: { ...MASTER_BASE, eq_on: 1, eq_hp: 25, eq_low: 1.5, eq_mid_freq: 3500, eq_mid_gain: -1, eq_mid_q: 0.7, eq_high: -1.5, limiter_ceiling: -0.3 } },
];

export function presetById(id: string): MixPreset | undefined {
  return MIX_PRESETS.find((x) => x.id === id);
}

/** A strip kind's presets, in menu order. */
export function presetsFor(kind: PresetKind): MixPreset[] {
  return MIX_PRESETS.filter((x) => x.kind === kind);
}

/** The preset kind of a mixer channel: a track id is 'track' (if it has a strip), else null. */
export function presetKindOf(p: Project, channel: MixChannelTarget): PresetKind | null {
  if (channel === 'reverb' || channel === 'delay' || channel === 'master') return channel;
  return p.mixer.channels[channel] && p.tracks.some((t) => t.id === channel) ? 'track' : null;
}

/**
 * Apply preset `presetId` to `channel` (a track id, 'reverb', 'delay' or
 * 'master'): every param of the preset through setMix (state + MIX_SET), in
 * catalog order, as ONE undo entry "Preset: <name>". On a keyed track strip
 * (header): Flat also clears the key; any other track preset skips the comp
 * section. False, with nothing
 * changed or sent, for an unknown preset or channel, or a preset of another
 * strip kind (a track preset on a return).
 *
 * Template builds (plan 27 Task 2) call this directly: `edit` makes no undo
 * entry when the project has no history yet, while it is loading, or while
 * it is baselining (state/edits.ts), and inside an outer edit it is part of
 * that one entry.
 */
export function applyPreset(p: Project, sink: CommandSink, channel: MixChannelTarget, presetId: string): boolean {
  const preset = presetById(presetId);
  if (!preset || presetKindOf(p, channel) !== preset.kind) return false;
  const keyed = preset.kind === 'track' && !!p.mixer.channels[channel]?.key;
  const flat = preset.id === 'flat';
  return edit(p, `Preset: ${preset.name}`, () => {
    if (keyed && flat) setSidechain(p, sink, channel, null);
    for (const d of MIX_PARAMS) {
      const v = preset.params[d.name];
      if (v === undefined || (keyed && !flat && d.group === 'comp')) continue;
      setMix(p, sink, channel, d.name, v);
    }
    return true;
  });
}
