import { describe, expect, it } from 'vitest';
import { Op, packPort } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { Project } from './project.svelte';
import { addDrumTrack, liveInputTrack, removeTrack, selectTrack } from './actions';
import { addModule, addSynthTrack, connect, disconnect, loadPatch, removeModule, setParam } from './rack-actions';
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
  it('sends SET_INPUT_TRACK only on change; drum selection keeps last synth', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    sent.length = 0;
    selectTrack(p, sink, s.id); // unchanged
    expect(sent).toHaveLength(0);
    selectTrack(p, sink, d.id);
    expect(sent).toHaveLength(0);
    expect(p.selectedTrackId).toBe(d.id);
    expect(liveInputTrack(p)?.id).toBe(s.id);
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
});
