import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { Op } from '../audio/protocol';
import { createHistory, debugStacks } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { buildFixture } from '../project/testFixture';
import { faderDb } from '../ui/mixer/mixMath';
import { fromPos } from '../ui/rack/knobMath';
import { removeTrack } from './actions';
import {
  LEARNABLE_CC, applyCc, ccValue, dropRackMappings, forgetMidi, learnMidi, learnableDef, mappingFor, mappingForCc, mappingLabel,
} from './midiMap';
import { loadPatch, removeModule } from './rack-actions';
import { STARTER_PATCHES } from './patches';
import type { AutoTarget } from './project.svelte';

const CUTOFF = paramIndex(moduleDef('filter'), 'cutoff');
const cutoff: AutoTarget = { kind: 'rack', module: 4, param: 'cutoff' };
const reso: AutoTarget = { kind: 'rack', module: 4, param: 'reso' };
const fader: AutoTarget = { kind: 'mix', param: 'fader' };

/** The fixture (Bass: a synth with its Filter at module 4) and a sink that records every command. */
async function rig(o: { history?: boolean } = {}) {
  const f = await buildFixture();
  const sent: number[][] = [];
  const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (sent.push([op, a, b, c, d]), true) };
  if (o.history) f.p.history = createHistory({ snapshot: () => serialize(f.p), apply: (from, to) => diffApply(f.p, sink, from, to) });
  return { ...f, sent, sink };
}

describe('MIDI mappings', () => {
  it('learn then apply moves a rack param', async () => {
    const { p, synth, sent, sink } = await rig();
    expect(learnMidi(p, 74, synth.id, cutoff)).toBe(true);
    expect(p.midiMap).toEqual([{ cc: 74, owner: synth.id, target: cutoff }]);
    const def = moduleDef('filter').params[CUTOFF];
    expect(applyCc(p, sink, 74, 127)).toBe(true);
    expect(synth.modules.find((m) => m.idx === 4)!.params[CUTOFF]).toBe(def.max);
    expect(sent).toEqual([[Op.RACK_SET_PARAM, synth.slot, 4, CUTOFF, def.max]]);
    applyCc(p, sink, 74, 0);
    expect(synth.modules.find((m) => m.idx === 4)!.params[CUTOFF]).toBe(def.min);
    expect(sent[1]).toEqual([Op.RACK_SET_PARAM, synth.slot, 4, CUTOFF, def.min]);
  });

  it('exp taper', async () => {
    const { p, synth, sink } = await rig();
    const def = moduleDef('filter').params[CUTOFF];
    expect(def.curve).toBe('exp');
    learnMidi(p, 74, synth.id, cutoff);
    applyCc(p, sink, 74, 64);
    expect(synth.modules.find((m) => m.idx === 4)!.params[CUTOFF]).toBe(fromPos(def, 64 / 127));
    expect(ccValue(def, 64)).toBe(fromPos(def, 64 / 127));
  });

  it('mix target', async () => {
    const { p, drums, sent, sink } = await rig();
    expect(learnMidi(p, 7, drums.id, fader)).toBe(true);
    applyCc(p, sink, 7, 127);
    expect(p.mixer.channels[drums.id].params[mixParam('fader').id]).toBe(6);
    expect(sent).toEqual([[Op.MIX_SET, drums.slot, mixParam('fader').id, 6, 0]]);
    // A Master-row channel too.
    expect(learnMidi(p, 10, 'reverb', { kind: 'mix', param: 'rev_size' })).toBe(true);
    applyCc(p, sink, 10, 0);
    expect(p.mixer.returns.find((r) => r.id === 'reverb')!.params[mixParam('rev_size').id]).toBe(mixParam('rev_size').min);
  });

  it('mapped fader follows the fader law; a knob still uses ccValue', async () => {
    const { p, drums, synth, sink } = await rig();
    learnMidi(p, 7, drums.id, fader);
    const db = () => p.mixer.channels[drums.id].params[mixParam('fader').id];
    applyCc(p, sink, 7, 95);
    expect(db()).toBe(faderDb(95 / 127));
    expect(Math.abs(db())).toBeLessThan(0.5); // ~0 dB
    applyCc(p, sink, 7, 0);
    expect(db()).toBe(-60);
    applyCc(p, sink, 7, 127);
    expect(db()).toBe(6);
    applyCc(p, sink, 7, 64);
    expect(db()).toBe(faderDb(64 / 127));
    const def = moduleDef('filter').params[CUTOFF];
    learnMidi(p, 74, synth.id, cutoff);
    applyCc(p, sink, 74, 64);
    expect(synth.modules.find((m) => m.idx === 4)!.params[CUTOFF]).toBe(fromPos(def, 64 / 127));
  });

  it('a mapped send follows the fader law too (plan 19: curve "fader")', async () => {
    const { p, drums, sink } = await rig();
    const send: AutoTarget = { kind: 'mix', param: 'send_a' };
    expect(learnMidi(p, 12, drums.id, send)).toBe(true);
    const db = () => p.mixer.channels[drums.id].params[mixParam('send_a').id];
    applyCc(p, sink, 12, 64);
    expect(db()).toBe(faderDb(64 / 127));
    expect(ccValue(mixParam('send_a'), 64)).toBe(faderDb(64 / 127));
    expect(ccValue(mixParam('fader'), 64)).toBe(faderDb(64 / 127));
    applyCc(p, sink, 12, 0);
    expect(db()).toBe(-60);
    applyCc(p, sink, 12, 127);
    expect(db()).toBe(6);
  });

  it('integer knobs are learnable (rounded)', async () => {
    const { p, synth, sink } = await rig();
    const osc = synth.modules.find((m) => moduleDef(m.kind).id === 'osc')!;
    const octave: AutoTarget = { kind: 'rack', module: osc.idx, param: 'octave' };
    expect(learnMidi(p, 20, synth.id, octave)).toBe(true);
    applyCc(p, sink, 20, 70);
    expect(osc.params[paramIndex(moduleDef('osc'), 'octave')]).toBe(Math.round(-3 + (70 / 127) * 6));
  });

  it('one cc one control', async () => {
    const { p, synth } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 74, synth.id, reso);
    expect(mappingFor(p, synth.id, cutoff)).toBeNull();
    expect(mappingFor(p, synth.id, reso)?.cc).toBe(74);
    learnMidi(p, 71, synth.id, reso);
    expect(mappingForCc(p, 74)).toBeNull();
    expect(mappingFor(p, synth.id, reso)?.cc).toBe(71);
    expect(p.midiMap).toHaveLength(1);
  });

  it('rejects 120..127 and non-integers', async () => {
    const { p, synth } = await rig({ history: true });
    for (const cc of [120, 121, 123, 127, 128, -1, 1.5, NaN]) {
      expect(LEARNABLE_CC(cc)).toBe(false);
      expect(learnMidi(p, cc, synth.id, cutoff)).toBe(false);
    }
    expect(LEARNABLE_CC(0) && LEARNABLE_CC(1) && LEARNABLE_CC(64) && LEARNABLE_CC(119)).toBe(true);
    // An unknown param, a rack target off a drum track, a param the channel does not take.
    expect(learnMidi(p, 3, synth.id, { kind: 'rack', module: 4, param: 'nope' })).toBe(false);
    expect(learnMidi(p, 3, p.tracks[0].id, cutoff)).toBe(false);
    expect(learnMidi(p, 3, 'master', { kind: 'mix', param: 'pan' })).toBe(false);
    expect(learnMidi(p, 3, 'no-such-track', fader)).toBe(false);
    expect(p.midiMap).toEqual([]);
    expect(p.history!.canUndo).toBe(false); // no edit
  });

  it('learning and forgetting are undoable edits', async () => {
    const { p, synth } = await rig({ history: true });
    learnMidi(p, 74, synth.id, cutoff);
    expect(p.history!.labels.undo).toBe('MIDI learn CC 74');
    expect(forgetMidi(p, synth.id, cutoff)).toBe(true);
    expect(p.history!.labels.undo).toBe('Forget MIDI CC 74');
    expect(p.midiMap).toEqual([]);
    expect(forgetMidi(p, synth.id, cutoff)).toBe(false); // nothing mapped
    p.history!.undo();
    expect(p.midiMap).toEqual([{ cc: 74, owner: synth.id, target: cutoff }]);
    p.history!.undo();
    expect(p.midiMap).toEqual([]);
    p.history!.redo();
    expect(mappingForCc(p, 74)).toEqual({ cc: 74, owner: synth.id, target: cutoff });
  });

  it('undo restores mappings onto a rebuilt track', async () => {
    const { p, synth, sink } = await rig({ history: true });
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 7, synth.id, fader);
    removeTrack(p, sink, synth.id);
    expect(p.midiMap).toEqual([]);
    p.history!.undo();
    // The track is rebuilt with a fresh id: the mappings follow it (by slot).
    const back = p.tracks.find((t) => t.slot === synth.slot)!;
    expect(p.midiMap).toEqual([{ cc: 74, owner: back.id, target: cutoff }, { cc: 7, owner: back.id, target: fader }]);
    expect(applyCc(p, sink, 74, 127)).toBe(true);
  });

  it('coalesces per cc', async () => {
    const { p, synth, sink } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 71, synth.id, reso);
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const filter = synth.modules.find((m) => m.idx === 4)!;
    const RESO = paramIndex(moduleDef('filter'), 'reso');
    const resoBefore = filter.params[RESO];
    const cutoffBefore = filter.params[CUTOFF];
    for (const v of [10, 20, 30]) applyCc(p, sink, 74, v);
    const cutoffSwept = filter.params[CUTOFF];
    for (const v of [100, 127]) applyCc(p, sink, 71, v);
    expect(debugStacks(p.history).undo).toHaveLength(2);
    expect(p.history.labels.undo).toBe('Set Resonance (MIDI)');
    p.history.undo();
    expect(filter.params[RESO]).toBe(resoBefore);
    expect(filter.params[CUTOFF]).toBe(cutoffSwept);
    expect(p.history.labels.undo).toBe('Set Cutoff (MIDI)');
    p.history.undo();
    expect(filter.params[CUTOFF]).toBe(cutoffBefore);
    expect(p.history.labels.undo).toBeNull(); // the learns came before the history
  });

  it('a coalesce key of its own starts a new entry (the router ends a sweep after a pause)', async () => {
    const { p, synth, sink } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const filter = synth.modules.find((m) => m.idx === 4)!;
    const before = filter.params[CUTOFF];
    applyCc(p, sink, 74, 10, undefined, 'midi:74:1');
    applyCc(p, sink, 74, 20, undefined, 'midi:74:1');
    const first = filter.params[CUTOFF];
    applyCc(p, sink, 74, 90, undefined, 'midi:74:2');
    expect(debugStacks(p.history).undo).toHaveLength(2);
    p.history.undo();
    expect(filter.params[CUTOFF]).toBe(first);
    p.history.undo();
    expect(filter.params[CUTOFF]).toBe(before);
  });

  it('learnableDef: continuous and integer, not choices or 0..1 flags', async () => {
    expect(learnableDef(moduleDef('filter').params[CUTOFF])).toBe(true);
    expect(learnableDef(moduleDef('osc').params[paramIndex(moduleDef('osc'), 'octave')])).toBe(true);
    expect(learnableDef(moduleDef('filter').params[paramIndex(moduleDef('filter'), 'mode')])).toBe(false);
    expect(learnableDef(mixParam('fader'))).toBe(true);
    expect(learnableDef(mixParam('delay_time'))).toBe(false); // a choice
    for (const flag of ['mute', 'solo', 'eq_on', 'comp_on', 'send_a_pre', 'send_b_pre', 'delay_ping_pong']) {
      expect(learnableDef(mixParam(flag))).toBe(false);
    }
    // learnMidi refuses them, without an edit.
    const { p, synth, drums } = await rig();
    expect(learnMidi(p, 20, drums.id, { kind: 'mix', param: 'mute' })).toBe(false);
    expect(learnMidi(p, 21, synth.id, { kind: 'rack', module: 4, param: 'mode' })).toBe(false);
    expect(learnMidi(p, 22, 'delay', { kind: 'mix', param: 'delay_ping_pong' })).toBe(false);
    expect(p.midiMap).toEqual([]);
  });

  it('dropped mappings are inert', async () => {
    // removeTrack
    {
      const { p, synth, sent, sink } = await rig();
      learnMidi(p, 74, synth.id, cutoff);
      learnMidi(p, 7, synth.id, fader);
      removeTrack(p, sink, synth.id);
      expect(p.midiMap).toEqual([]);
      sent.length = 0;
      expect(applyCc(p, sink, 74, 100)).toBe(false);
      expect(applyCc(p, sink, 7, 100)).toBe(false);
      expect(sent).toEqual([]);
    }
    // removeModule: only that module's mappings go
    {
      const { p, synth, sent, sink } = await rig();
      const osc = synth.modules.find((m) => moduleDef(m.kind).id === 'osc')!;
      learnMidi(p, 74, synth.id, cutoff);
      learnMidi(p, 20, synth.id, { kind: 'rack', module: osc.idx, param: 'tune' });
      removeModule(p, sink, synth.id, 4);
      expect(p.midiMap.map((m) => m.cc)).toEqual([20]);
      sent.length = 0;
      expect(applyCc(p, sink, 74, 100)).toBe(false);
      expect(sent).toEqual([]);
    }
    // loadPatch: the rack mappings go, the track's mixer mapping stays
    {
      const { p, synth, sent, sink } = await rig();
      learnMidi(p, 74, synth.id, cutoff);
      learnMidi(p, 7, synth.id, fader);
      loadPatch(p, sink, synth.id, STARTER_PATCHES[1]);
      expect(p.midiMap).toEqual([{ cc: 7, owner: synth.id, target: fader }]);
      sent.length = 0;
      expect(applyCc(p, sink, 74, 100)).toBe(false);
      expect(sent).toEqual([]);
      expect(applyCc(p, sink, 7, 100)).toBe(true);
    }
    // A mapping whose target vanished some other way is inert too (no throw).
    {
      const { p, synth, sent, sink } = await rig();
      learnMidi(p, 74, synth.id, cutoff);
      synth.modules = synth.modules.filter((m) => m.idx !== 4);
      sent.length = 0;
      expect(applyCc(p, sink, 74, 100)).toBe(false);
      expect(sent).toEqual([]);
      dropRackMappings(p, synth.id);
      expect(p.midiMap).toEqual([]);
    }
  });

  it('dropping shares the removal’s undo entry', async () => {
    const { p, synth, sink } = await rig({ history: true });
    learnMidi(p, 74, synth.id, cutoff);
    removeModule(p, sink, synth.id, 4);
    expect(p.history!.labels.undo).toBe('Remove module');
    p.history!.undo();
    expect(p.midiMap).toEqual([{ cc: 74, owner: synth.id, target: cutoff }]);
    expect(p.history!.labels.undo).toBe('MIDI learn CC 74');
  });

  it('touch is called', async () => {
    const { p, synth, drums, sink } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 7, drums.id, fader);
    const touched: unknown[] = [];
    const touch = (owner: unknown, target: unknown) => touched.push([owner, target]);
    applyCc(p, sink, 74, 1, touch);
    applyCc(p, sink, 7, 1, touch);
    applyCc(p, sink, 9, 1, touch); // unmapped
    expect(touched).toEqual([[synth.id, cutoff], [drums.id, fader]]);
  });

  it('labels', async () => {
    const { p, synth } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 7, synth.id, fader);
    learnMidi(p, 8, 'master', { kind: 'mix', param: 'limiter_ceiling' });
    const [a, b, c] = p.midiMap;
    expect(mappingLabel(p, a)).toBe('Bass · Filter · Cutoff');
    expect(mappingLabel(p, b)).toBe('Bass · Volume');
    expect(mappingLabel(p, c)).toBe(`Master · ${mixParam('limiter_ceiling').label}`);
  });
});
