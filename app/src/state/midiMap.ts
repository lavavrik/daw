// MIDI-learn mappings (plan 14; docs/architecture/midi.md): which Control
// Change number moves which knob or fader. The model lives on
// Project.midiMap and is saved with the project (schema v4 `midiMap`), so
// learning and forgetting are ordinary undoable edits and an undo snapshot
// carries the list (history/diffApply.ts restores it whole).
//
// Rules (spec addendum §2):
//   - Keyed by the CC number alone: omni (any channel, any device).
//   - One CC -> one control, one control -> one CC: learning either side
//     replaces the old mapping (learnMidi).
//   - Learnable CCs are 0..119 (LEARNABLE_CC): 120..127 are channel-mode
//     messages (120/123 are our panic). CC1 and CC64 keep their built-in
//     meaning (mod wheel, sustain) and are also learnable.
//   - A control is named exactly as automation names a lane target: an owner
//     (a track id, a return id or 'master') plus an AutoTarget. Unlike
//     a lane, an INTEGER param (octave, unison, voices) may be mapped too: the
//     knob's own taper and clampParam round it (mappingDef). Choice params
//     and 0..1 on/off flags are never learnable (learnableDef: learnMidi
//     refuses them, validate drops them, the UI does not offer them).
//   - Lifetime: removing a track drops its mappings; removing a rack module
//     drops that module's; loading a patch drops the track's rack mappings
//     (its mixer mappings stay). The drop* helpers are plain mutations,
//     called INSIDE the removal's own edit so they share its undo entry.
//   - A CC move goes through the normal setParam / setMix action with a
//     coalesce key (`midi:<cc>` by default; the UI router adds a sweep
//     number, `midi:<cc>:<n>`, so a 1 s pause ends a sweep), so a sweep on
//     one CC is one undo entry ("Set Cutoff (MIDI)"), like a knob drag; a
//     sweep on another CC starts a new one. Rate limiting (one move per
//     frame) and sweep boundaries are the UI's job (ui/midiLearn.svelte.ts),
//     not this module's.
import { moduleDef, paramIndex } from '../audio/catalog';
import { MIX_PARAMS } from '../audio/mixerCatalog';
import { faderDb } from '../ui/mixer/mixMath';
import { fromPos } from '../ui/rack/knobMath';
import type { KnobDef } from '../ui/rack/knobMath';
import type { CommandSink } from './actions';
import { isMasterChannel, sameTarget } from './automation';
import type { AutoDef } from './automation';
import { edit, markEdited } from './edits';
import { accepts, resolveChannel, setMix } from './mixer-actions';
import { findReturn } from './returns';
import type { MixChannelTarget } from './mixer-actions';
import { setParam } from './rack-actions';
import type { AutoTarget, Project } from './project.svelte';

/**
 * Can a control with catalog def `def` be learned? Continuous and integer
 * knobs/faders: yes. Choice params (a radio group: wave, filter mode, delay
 * division) and 0..1 integer flags (mute, solo, eq_on, comp_on,
 * send_*_pre, delay_ping_pong: on/off buttons): no. Used by the UI
 * (ui/midiLearn canLearn), learnMidi and the schema's validate.
 */
export function learnableDef(def: Pick<AutoDef, 'choices' | 'integer' | 'min' | 'max'>): boolean {
  if (def.choices.length) return false;
  return !(def.integer && def.min === 0 && def.max === 1);
}

/** One mapping: CC `cc` moves `target` of `owner` (a track id, or a Master-row channel: a return id or 'master'). */
export interface MidiMapping {
  cc: number;
  owner: MixChannelTarget;
  target: AutoTarget;
}

/** CC numbers a mapping may use: 0..119 (120..127 are channel-mode messages). */
export const LEARNABLE_CC = (cc: number) => Number.isInteger(cc) && cc >= 0 && cc <= 119;

const isControl = (m: MidiMapping, owner: MixChannelTarget, target: AutoTarget) => m.owner === owner && sameTarget(m.target, target);

/**
 * The catalog def of `target` on `owner` in `p`, or null when that control
 * does not exist: an unknown track or param, a mixer param the channel does
 * not take (mixer-actions accepts), a rack target off a synth track or on a
 * module the rack does not have. Like automation's targetDef, but integer
 * params are allowed (a learned octave knob steps through its values).
 */
export function mappingDef(p: Project, owner: MixChannelTarget, target: AutoTarget): AutoDef | null {
  if (isMasterChannel(p, owner)) {
    if (target.kind !== 'mix') return null;
    const def = MIX_PARAMS.find((d) => d.name === target.param);
    const ch = resolveChannel(p, owner)!;
    return def && accepts(def, ch.kind, ch.index, ch.retKind) ? def : null;
  }
  const t = p.tracks.find((x) => x.id === owner);
  if (!t) return null;
  if (target.kind === 'mix') {
    const def = MIX_PARAMS.find((d) => d.name === target.param);
    return def && p.mixer.channels[t.id] && accepts(def, 'track', t.slot) ? def : null;
  }
  if (t.kind !== 'synth') return null;
  const m = t.modules.find((x) => x.idx === target.module);
  return (m && moduleDef(m.kind).params.find((d) => d.name === target.param)) || null;
}

/** The mapping of this control, or null. */
export function mappingFor(p: Project, owner: MixChannelTarget, target: AutoTarget): MidiMapping | null {
  return p.midiMap.find((m) => isControl(m, owner, target)) ?? null;
}

/** The mapping of CC `cc`, or null. */
export function mappingForCc(p: Project, cc: number): MidiMapping | null {
  return p.midiMap.find((m) => m.cc === cc) ?? null;
}

/**
 * Map CC `cc` to the control: one edit "MIDI learn CC <cc>" that first drops
 * any mapping of that CC and any of that control. False (and no edit) when
 * the CC is not learnable, the control does not exist (mappingDef) or is a
 * choice / on-off flag (learnableDef).
 */
export function learnMidi(p: Project, cc: number, owner: MixChannelTarget, target: AutoTarget): boolean {
  const def = mappingDef(p, owner, target);
  if (!LEARNABLE_CC(cc) || !def || !learnableDef(def)) return false;
  const had = mappingForCc(p, cc);
  if (had && isControl(had, owner, target)) return true; // already so: nothing to do
  return edit(p, `MIDI learn CC ${cc}`, () => {
    const t: AutoTarget = target.kind === 'mix' ? { kind: 'mix', param: target.param } : { kind: 'rack', module: target.module, param: target.param };
    p.midiMap = [...p.midiMap.filter((m) => m.cc !== cc && !isControl(m, owner, target)), { cc, owner, target: t }];
    markEdited(p); // no engine command marks this edit
    return true;
  });
}

/** Unmap the control: one edit "Forget MIDI CC <cc>". False when it has no mapping. */
export function forgetMidi(p: Project, owner: MixChannelTarget, target: AutoTarget): boolean {
  const m = mappingFor(p, owner, target);
  if (!m) return false;
  return edit(p, `Forget MIDI CC ${m.cc}`, () => {
    p.midiMap = p.midiMap.filter((x) => !isControl(x, owner, target));
    markEdited(p);
    return true;
  });
}

/** Plain mutation (no edit, no command): the mappings `gone` selects leave the list. */
function dropWhere(p: Project, gone: (m: MidiMapping) => boolean) {
  if (p.midiMap.some(gone)) p.midiMap = p.midiMap.filter((m) => !gone(m));
}

/** Every mapping of track `trackId` (rack and mixer). Call inside the removal's edit. */
export function dropTrackMappings(p: Project, trackId: string) {
  dropWhere(p, (m) => m.owner === trackId);
}

/** The mappings on module `moduleIdx` of track `trackId`'s rack. Call inside the removal's edit. */
export function dropModuleMappings(p: Project, trackId: string, moduleIdx: number) {
  dropWhere(p, (m) => m.owner === trackId && m.target.kind === 'rack' && m.target.module === moduleIdx);
}

/** Every rack mapping of track `trackId` (a patch load); its mixer mappings stay. Call inside the load's edit. */
export function dropRackMappings(p: Project, trackId: string) {
  dropWhere(p, (m) => m.owner === trackId && m.target.kind === 'rack');
}

/**
 * CC value 0..127 -> param value: the knob's own taper (knobMath fromPos).
 * Clamping and integer rounding happen in the action's clampParam
 * (setParam / setMix), as for a drag. A 'fader'-curve param (the fader and
 * both sends, plan 19) follows the fader law as the on-screen fader's drag
 * does, snapped to 0.1 dB (faderDb; plan 14 ruling G: the hardware fader and
 * the on-screen fader must match, and a send knob now moves like a fader).
 */
export function ccValue(def: KnobDef, v: number): number {
  return def.curve === 'fader' ? faderDb(v / 127) : fromPos(def, v / 127);
}

/**
 * CC `cc` arrived with value `v` (0..127): move its mapped control through
 * the normal action (setParam / setMix, so the model, the engine and the
 * knob all follow), as an undo entry "Set <param label> (MIDI)" that merges
 * with the previous moves of the same coalesce key (`coalesce`, default
 * `midi:<cc>`; the UI router passes `midi:<cc>:<sweep>` so a pause of 1 s
 * ends a sweep, ui/midiLearn.svelte.ts). Then
 * `touch(owner, target)` (the UI: override the target's automation lane,
 * as a drag does). False, doing nothing, when the CC is unmapped or its
 * control no longer resolves.
 */
export function applyCc(
  p: Project, sink: CommandSink, cc: number, v: number, touch?: (owner: MixChannelTarget, target: AutoTarget) => void,
  coalesce = `midi:${cc}`,
): boolean {
  const m = mappingForCc(p, cc);
  if (!m) return false;
  const def = mappingDef(p, m.owner, m.target);
  if (!def) return false;
  const value = ccValue(def, v);
  const opts = { coalesce, label: `Set ${def.label} (MIDI)` };
  if (m.target.kind === 'rack') {
    const t = p.tracks.find((x) => x.id === m.owner);
    const mod = t?.kind === 'synth' ? t.modules.find((x) => x.idx === (m.target as { module: number }).module) : undefined;
    if (!t || !mod) return false;
    setParam(p, sink, t.id, mod.idx, paramIndex(moduleDef(mod.kind), m.target.param), value, opts);
  } else setMix(p, sink, m.owner, m.target.param, value, opts);
  touch?.(m.owner, m.target);
  return true;
}

/**
 * How a mapping reads in the mapping list: "Bass · Filter · Cutoff" (rack),
 * "Bass · Volume" or "Reverb · Size" (mixer). Falls back to the saved names
 * for a control that no longer resolves.
 */
export function mappingLabel(p: Project, m: MidiMapping): string {
  const owner = m.owner === 'master' ? 'Master' : (findReturn(p, m.owner) ?? p.tracks.find((t) => t.id === m.owner))?.name ?? '?';
  const param = mappingDef(p, m.owner, m.target)?.label ?? m.target.param;
  if (m.target.kind === 'mix') return `${owner} · ${param}`;
  const t = p.tracks.find((x) => x.id === m.owner);
  const mod = t?.kind === 'synth' ? t.modules.find((x) => x.idx === (m.target as { module: number }).module) : undefined;
  return `${owner} · ${mod ? moduleDef(mod.kind).name : `Module ${m.target.module}`} · ${param}`;
}
