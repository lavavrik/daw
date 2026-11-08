import { describe, expect, it } from 'vitest';
import { Op, packPort } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { Project } from './project.svelte';
import { addDrumTrack, liveInputTrack, removeTrack, selectTrack } from './actions';
import {
  addModule, addSynthTrack, connect, disconnect, fxPoolFullText, fxSlotsFree, loadPatch, removeModule,
  rollbackRefusedAdd, setParam, setParams, setRackLayout,
} from './rack-actions';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { STARTER_PATCHES } from './patches';

function fake() {
  const sent: number[][] = [];
  return {
    sent,
    sink: {
      send(op: number, a = 0, b = 0, c = 0, d = 0) {
        sent.push([op, a, b, c, d]);
        return true;
      },
    },
  };
}
const ops = (sent: number[][]) => sent.map((s) => s[0]);

describe('rack actions', () => {
  it('addSynthTrack: slot after drums, command order, selects + input', () => {
    const p = new Project();
    const { sink, sent } = fake();
    addDrumTrack(p, sink);
    sent.length = 0;
    const t = addSynthTrack(p, sink)!;
    expect(t.kind).toBe('synth');
    expect(t.slot).toBe(1);
    expect(sent[0]).toEqual([Op.ADD_SYNTH_TRACK, 1, 0, 0, 0]);
    expect(sent[1]).toEqual([Op.SET_PATTERN_BARS, 1, 4, 0, 0]);
    expect(sent[2][0]).toBe(Op.RACK_CLEAR);
    expect(t.patterns).toEqual([{ id: t.currentPatternId, engineIdx: 0, name: 'Pattern 1', bars: 4, notes: [] }]);
    expect(t.clips).toEqual([]);
    expect(sent[sent.length - 1]).toEqual([Op.SET_INPUT_TRACK, 1, 0, 0, 0]);
    const firstConnect = ops(sent).indexOf(Op.RACK_CONNECT);
    expect(ops(sent).lastIndexOf(Op.RACK_ADD_MODULE)).toBeLessThan(firstConnect);
    expect(p.selectedTrackId).toBe(t.id);
    expect(p.lastSynthTrackId).toBe(t.id);
    expect(t.patchName).toBe('Deep Bass');
    expect(t.modules).toHaveLength(STARTER_PATCHES[0].modules.length);
  });

  it('loadPatch sends only non-default params; state holds full array', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink, 'S', STARTER_PATCHES[2])!;
    const osc = moduleDef('osc');
    const patchOsc = STARTER_PATCHES[2].modules.find((m) => m.id === 'osc')!;
    const sets = sent.filter((s) => s[0] === Op.RACK_SET_PARAM);
    const oscSets = sets.filter((s) => s[2] === patchOsc.idx);
    // saw is wave 0 = default, so only unison and detune are sent
    expect(oscSets.map((s) => s[3]).sort()).toEqual([paramIndex(osc, 'unison'), paramIndex(osc, 'detune')].sort());
    const m = t.modules.find((x) => x.idx === patchOsc.idx)!;
    expect(m.params).toHaveLength(osc.params.length);
    expect(m.params[paramIndex(osc, 'unison')]).toBe(4);
    expect(m.params[paramIndex(osc, 'wave')]).toBe(0);
  });

  it('connect replaces the cable on the same input (state + command)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    const a = addModule(p, sink, t.id, 'noise')!;
    const b = addModule(p, sink, t.id, 'lfo')!;
    const v = addModule(p, sink, t.id, 'vca')!;
    sent.length = 0;
    connect(p, sink, t.id, { m: a, port: 0 }, { m: v, port: 0 });
    connect(p, sink, t.id, { m: b, port: 0 }, { m: v, port: 0 });
    expect(t.cables).toEqual([{ from: { m: b, port: 0 }, to: { m: v, port: 0 } }]);
    expect(sent[1]).toEqual([Op.RACK_CONNECT, t.slot, packPort(b, 0), packPort(v, 0), 0]);
    disconnect(p, sink, t.id, { m: v, port: 0 });
    expect(t.cables).toHaveLength(0);
    expect(sent[2]).toEqual([Op.RACK_DISCONNECT, t.slot, packPort(v, 0), 0, 0]);
  });

  it('addModule uses lowest free idx and returns null when full', () => {
    const p = new Project();
    const { sink } = fake();
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    expect(addModule(p, sink, t.id, 'osc')).toBe(0);
    expect(addModule(p, sink, t.id, 'osc')).toBe(1);
    removeModule(p, sink, t.id, 0);
    expect(addModule(p, sink, t.id, 'osc')).toBe(0);
    for (let i = 2; i < 32; i++) expect(addModule(p, sink, t.id, 'osc')).toBe(i);
    expect(addModule(p, sink, t.id, 'osc')).toBeNull();
  });

  it('pooled effects share the engine FX pool across tracks (9th delay refused)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const empty = { name: 'e', modules: [], cables: [] };
    const a = addSynthTrack(p, sink, 'A', empty)!;
    const b = addSynthTrack(p, sink, 'B', empty)!;
    expect(fxSlotsFree(p, 'delay')).toBe(8);
    expect(fxSlotsFree(p, 'eq')).toBe(Infinity);
    for (let i = 0; i < 4; i++) {
      expect(addModule(p, sink, a.id, 'delay')).not.toBeNull();
      expect(addModule(p, sink, b.id, 'delay')).not.toBeNull();
    }
    expect(fxSlotsFree(p, 'delay')).toBe(0);
    sent.length = 0;
    expect(addModule(p, sink, a.id, 'delay')).toBeNull();
    expect(sent).toEqual([]); // never sent: the engine would answer ERR_OUT_OF_MEMORY
    expect(addModule(p, sink, a.id, 'reverb')).not.toBeNull(); // its own bank
    removeModule(p, sink, b.id, b.modules[0].idx);
    expect(fxSlotsFree(p, 'delay')).toBe(1);
    expect(addModule(p, sink, a.id, 'delay')).not.toBeNull();
  });

  it('the ninth scope is refused like a full FX bank', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const empty = { name: 'e', modules: [], cables: [] };
    const a = addSynthTrack(p, sink, 'A', empty)!;
    const b = addSynthTrack(p, sink, 'B', empty)!;
    expect(fxSlotsFree(p, 'scope')).toBe(8);
    for (let i = 0; i < 5; i++) expect(addModule(p, sink, a.id, 'scope')).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(addModule(p, sink, b.id, 'scope')).not.toBeNull();
    expect(fxSlotsFree(p, 'scope')).toBe(0);
    sent.length = 0;
    expect(addModule(p, sink, b.id, 'scope')).toBeNull();
    expect(sent).toEqual([]); // never sent
    expect(fxPoolFullText(moduleDef('scope'))).toBe('All 8 scopes in use');
    expect(fxSlotsFree(p, 'delay')).toBe(8); // their own bank
    removeModule(p, sink, a.id, a.modules[0].idx);
    expect(addModule(p, sink, b.id, 'scope')).not.toBeNull();
    // The engine refusing one anyway (a slot still held elsewhere) rolls back with the same text.
    const idx = b.modules[b.modules.length - 1].idx;
    expect(rollbackRefusedAdd(p, b.slot, idx, moduleDef('scope').kind)).toBe('All 8 scopes in use');
  });

  it('setParam clamps', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    const f = addModule(p, sink, t.id, 'filter')!;
    sent.length = 0;
    setParam(p, sink, t.id, f, 1, 1e9);
    expect(sent).toEqual([[Op.RACK_SET_PARAM, t.slot, f, 1, 20000]]);
    expect(t.modules[0].params[1]).toBe(20000);
  });

  it('setParams: several params of one module in one undo entry (the Sample Player strip\'s End push)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    const sp = addModule(p, sink, t.id, 'sample_player')!;
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const d = moduleDef('sample_player');
    const [end, ls] = [paramIndex(d, 'end'), paramIndex(d, 'loopStart')];
    setParam(p, sink, t.id, sp, ls, 0.5);
    sent.length = 0;
    setParams(p, sink, t.id, sp, [[end, 0.4], [ls, 0.3]]);
    expect(sent).toEqual([[Op.RACK_SET_PARAM, t.slot, sp, end, 0.4], [Op.RACK_SET_PARAM, t.slot, sp, ls, 0.3]]);
    expect(p.history.labels.undo).toBe('Set End');
    p.history.undo(); // both at once
    const m = t.modules.find((x) => x.idx === sp)!;
    expect([m.params[end], m.params[ls]]).toEqual([1, 0.5]);
  });

  it('removeModule removes its cables in state', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink)!;
    const n = t.cables.length;
    const adsr = t.modules.find((m) => m.kind === moduleDef('adsr').kind)!.idx;
    const touching = t.cables.filter((c) => c.from.m === adsr || c.to.m === adsr).length;
    expect(touching).toBeGreaterThan(0);
    sent.length = 0;
    removeModule(p, sink, t.id, adsr);
    expect(t.cables).toHaveLength(n - touching);
    expect(t.modules.some((m) => m.idx === adsr)).toBe(false);
    expect(sent).toEqual([[Op.RACK_REMOVE_MODULE, t.slot, adsr, 0, 0]]);
  });
});

describe('input track selection', () => {
  it('sends SET_INPUT_TRACK only on change; a selected drum track is the input (plan 15)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    sent.length = 0;
    selectTrack(p, sink, s.id); // unchanged
    expect(sent).toHaveLength(0);
    selectTrack(p, sink, d.id);
    expect(sent).toEqual([[Op.SET_INPUT_TRACK, d.slot, 0, 0, 0]]);
    expect(p.selectedTrackId).toBe(d.id);
    expect(liveInputTrack(p)?.id).toBe(d.id);
    expect(p.lastSynthTrackId).toBe(s.id);
    const s2 = addSynthTrack(p, sink)!;
    expect(sent[sent.length - 1]).toEqual([Op.SET_INPUT_TRACK, s2.slot, 0, 0, 0]);
  });

  it('removeTrack of input sends -1 when no synth remains, else the new input', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const s1 = addSynthTrack(p, sink)!;
    const s2 = addSynthTrack(p, sink)!;
    sent.length = 0;
    removeTrack(p, sink, s2.id);
    expect(sent).toEqual([[Op.REMOVE_TRACK, s2.slot, 0, 0, 0], [Op.SET_INPUT_TRACK, s1.slot, 0, 0, 0]]);
    expect(p.selectedTrackId).toBe(s1.id);
    sent.length = 0;
    removeTrack(p, sink, s1.id);
    expect(sent).toEqual([[Op.REMOVE_TRACK, s1.slot, 0, 0, 0], [Op.SET_INPUT_TRACK, -1, 0, 0, 0]]);
    expect(p.selectedTrackId).toBeNull();
    expect(p.lastSynthTrackId).toBeNull();
  });

  it('removeTrack landing on a synth makes it the last synth (keys follow the visible synth)', () => {
    const p = new Project();
    const { sink } = fake();
    const s1 = addSynthTrack(p, sink)!;
    const d = addDrumTrack(p, sink)!;
    const s2 = addSynthTrack(p, sink)!;
    selectTrack(p, sink, s1.id);
    selectTrack(p, sink, d.id); // last synth = s1
    removeTrack(p, sink, d.id); // selection moves to s2
    expect(p.selectedTrackId).toBe(s2.id);
    expect(p.lastSynthTrackId).toBe(s2.id);
    expect(liveInputTrack(p)?.id).toBe(s2.id);
  });

  it('loadPatch can be reloaded onto an existing track', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink)!;
    sent.length = 0;
    loadPatch(p, sink, t.id, STARTER_PATCHES[4]);
    expect(sent[0]).toEqual([Op.RACK_CLEAR, t.slot, 0, 0, 0]);
    expect(t.patchName).toBe('Pluck');
  });
  it('rollbackRefusedAdd undoes an add the engine refused (FX pool full)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addSynthTrack(p, sink)!;
    const delay = moduleDef('delay');
    const idx = addModule(p, sink, t.id, 'delay')!;
    const out = t.modules.find((m) => moduleDef(m.kind).id === 'out')!;
    connect(p, sink, t.id, { m: idx, port: 0 }, { m: out.idx, port: 0 });
    const cables = t.cables.length;
    sent.length = 0;
    // The worklet reports (slot, idx, kind) of the refused RACK_ADD_MODULE.
    expect(rollbackRefusedAdd(p, t.slot, idx, delay.kind)).toBe('All 8 delays in use');
    expect(t.modules.some((m) => m.idx === idx)).toBe(false);
    expect(t.cables.length).toBe(cables - 1); // its cables go too
    expect(sent).toEqual([]); // nothing to undo in the engine: it added nothing
    // Already gone, another kind there, or no such track: nothing to do.
    expect(rollbackRefusedAdd(p, t.slot, idx, delay.kind)).toBeNull();
    expect(rollbackRefusedAdd(p, t.slot, out.idx, delay.kind)).toBeNull();
    expect(rollbackRefusedAdd(p, 31, 0, delay.kind)).toBeNull();
    expect(fxPoolFullText(moduleDef('chorus'))).toBe('All 16 choruses in use');
    expect(fxPoolFullText(moduleDef('eq'))).toBe('');
  });
});

describe('rack layout (pos)', () => {
  function rig() {
    const p = new Project();
    const { sink } = fake();
    const t = addSynthTrack(p, sink, 'S', { name: 'e', modules: [], cables: [] })!;
    const a = addModule(p, sink, t.id, 'osc')!;
    const b = addModule(p, sink, t.id, 'adsr')!;
    const c = addModule(p, sink, t.id, 'filter')!;
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    return { p, sink, t, a, b, c };
  }
  const L = [(a: number, b: number) => [{ idx: a, pos: { row: 0, x: 0 } }, { idx: b, pos: { row: 1, x: 12 } }]][0];

  it('set_layout_one_entry', () => {
    const { p, t, a, b, c } = rig();
    expect(setRackLayout(p, t.id, L(a, b), 'Move module')).toBe(true);
    expect(t.modules.find((m) => m.idx === a)!.pos).toEqual({ row: 0, x: 0 });
    expect(t.modules.find((m) => m.idx === b)!.pos).toEqual({ row: 1, x: 12 });
    expect(t.modules.find((m) => m.idx === c)!.pos).toBeUndefined();
    expect(p.history!.labels.undo).toBe('Move module');
    expect(p.dirty).toBe(true);
    p.history!.undo();
    expect(t.modules.every((m) => m.pos === undefined)).toBe(true);
    expect(p.history!.canUndo).toBe(false); // the layout was the only entry
    p.history!.redo();
    expect(t.modules.find((m) => m.idx === b)!.pos).toEqual({ row: 1, x: 12 });
  });

  it('set_layout_noop_no_entry', () => {
    const { p, t, a, b } = rig();
    expect(setRackLayout(p, t.id, [], 'Move module')).toBe(false); // nothing positioned, nothing to clear
    expect(setRackLayout(p, t.id, null, 'Tidy rack')).toBe(false);
    expect(p.history!.canUndo).toBe(false);
    setRackLayout(p, t.id, L(a, b), 'Move module');
    const labels = p.history!.labels.undo;
    expect(setRackLayout(p, t.id, L(a, b), 'Move module')).toBe(false);
    expect(p.history!.labels.undo).toBe(labels);
    p.history!.undo();
    expect(p.history!.canUndo).toBe(false); // only one layout entry existed
  });

  it('tidy_clears', () => {
    const { p, t, a, b } = rig();
    setRackLayout(p, t.id, L(a, b), 'Move module');
    expect(setRackLayout(p, t.id, null, 'Tidy rack')).toBe(true);
    expect(t.modules.every((m) => m.pos === undefined && !('pos' in m))).toBe(true);
    expect(p.history!.labels.undo).toBe('Tidy rack');
    p.history!.undo();
    expect(t.modules.find((m) => m.idx === a)!.pos).toEqual({ row: 0, x: 0 });
  });

  it('coalesces moves with the same key', () => {
    const { p, t, a } = rig();
    setRackLayout(p, t.id, [{ idx: a, pos: { row: 0, x: 1 } }], 'Move module', 'rackmove:k');
    setRackLayout(p, t.id, [{ idx: a, pos: { row: 0, x: 2 } }], 'Move module', 'rackmove:k');
    p.history!.undo();
    expect(t.modules.find((m) => m.idx === a)!.pos).toBeUndefined();
  });

  it('sends no engine command', () => {
    const { p, t, a, b } = rig();
    const { sink, sent } = fake();
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    setRackLayout(p, t.id, L(a, b), 'Move module');
    p.history!.undo();
    p.history!.redo();
    expect(sent).toEqual([]);
  });

  it('undo_restores_pos', () => {
    const { p, sink, t, a, b } = rig();
    setRackLayout(p, t.id, L(a, b), 'Move module');
    removeModule(p, sink, t.id, b);
    expect(t.modules.some((m) => m.idx === b)).toBe(false);
    p.history!.undo();
    expect(t.modules.find((m) => m.idx === b)!.pos).toEqual({ row: 1, x: 12 });
    expect(t.modules.find((m) => m.idx === a)!.pos).toEqual({ row: 0, x: 0 });
  });

  it('load_patch_keeps_pos', () => {
    const p = new Project();
    const { sink } = fake();
    const t = addSynthTrack(p, sink)!;
    const patch = JSON.parse(JSON.stringify(STARTER_PATCHES[0]));
    patch.modules[0].pos = { row: 3, x: 40 };
    loadPatch(p, sink, t.id, patch);
    expect(t.modules.find((m) => m.idx === patch.modules[0].idx)!.pos).toEqual({ row: 3, x: 40 });
    expect(t.modules.filter((m) => m.pos)).toHaveLength(1);
    loadPatch(p, sink, t.id, STARTER_PATCHES[0]); // a patch without positions clears them
    expect(t.modules.some((m) => m.pos)).toBe(false);
  });
});
