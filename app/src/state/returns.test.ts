import { describe, expect, it } from 'vitest';
import { MIX_RETURN0 } from '../audio/protocol';
import { defaultMixParams } from '../audio/mixerCatalog';
import { Op, sendParam, sendPreParam } from '../audio/protocol';
import { mixParam } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import { addDrumTrack } from './actions';
import { addLane } from './automation-actions';
import { learnMidi } from './midiMap';
import { setMix } from './mixer-actions';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { masterChannelIndex, projectCommands } from '../project/commands';
import {
  addReturn, deleteReturn, renameReturn,
  KIND_CODE, MAX_RETURNS, findReturn, firstReturnOfKind, freeSlot, nextReturnName, returnChannel, returnColor,
} from './returns';
import type { ReturnKind, ReturnState } from './returns';
import { RETURN_COLORS } from '../ui/theme';

const ret = (slot: number, kind: ReturnKind, name: string, id = `r${slot}`): ReturnState =>
  ({ id, kind, name, slot, params: defaultMixParams(), key: null });

describe('returns', () => {
  it('a new project has the default layout: Reverb on slot 0, Delay on slot 1', () => {
    const p = new Project();
    expect(p.mixer.returns.map(({ id, kind, name, slot }) => ({ id, kind, name, slot }))).toEqual([
      { id: 'reverb', kind: 'reverb', name: 'Reverb', slot: 0 },
      { id: 'delay', kind: 'delay', name: 'Delay', slot: 1 },
    ]);
    expect(p.mixer.returns.every((r) => r.key === null && r.params.length === defaultMixParams().length)).toBe(true);
    expect(MAX_RETURNS).toBe(8);
    expect(KIND_CODE).toEqual({ off: 0, reverb: 1, delay: 2 });
  });

  it('channel, colour and lookups', () => {
    const p = new Project();
    p.mixer.returns.push(ret(4, 'reverb', 'Reverb 2'));
    expect(returnChannel(findReturn(p, 'r4')!)).toBe(MIX_RETURN0 + 4);
    expect(returnColor(4)).toBe('var(--return-4)');
    expect(RETURN_COLORS).toHaveLength(MAX_RETURNS); // one theme token per slot (theme.test.ts mirrors them)
    expect(findReturn(p, 'nope')).toBeUndefined();
    expect(firstReturnOfKind(p, 'reverb')?.id).toBe('reverb'); // creation order, not slot order
    expect(firstReturnOfKind(p, 'delay')?.id).toBe('delay');
    p.mixer.returns = p.mixer.returns.filter((r) => r.kind !== 'delay');
    expect(firstReturnOfKind(p, 'delay')).toBeUndefined();
  });

  it('nextReturnName: "Reverb 2" next to "Reverb", "Reverb 3" when "Reverb 2" exists', () => {
    const p = new Project();
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 2');
    expect(nextReturnName(p, 'delay')).toBe('Delay 2');
    p.mixer.returns.push(ret(2, 'reverb', 'Reverb 2'));
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 3');
    expect(nextReturnName(p, 'delay')).toBe('Delay 2'); // by kind
    p.mixer.returns.push(ret(3, 'reverb', 'Reverb 4'));
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 3'); // the lowest free number
    p.mixer.returns = [];
    expect(nextReturnName(p, 'reverb')).toBe('Reverb 2'); // N >= 2 even with none
  });

  it('freeSlot gives the lowest free slot, and null at 8', () => {
    const p = new Project();
    expect(freeSlot(p)).toBe(2);
    p.mixer.returns = [ret(1, 'delay', 'Delay'), ret(3, 'reverb', 'Reverb')];
    expect(freeSlot(p)).toBe(0);
    p.mixer.returns = Array.from({ length: 7 }, (_, i) => ret(i === 5 ? 7 : i, 'reverb', 'R'));
    expect(freeSlot(p)).toBe(5);
    p.mixer.returns = Array.from({ length: 8 }, (_, i) => ret(i, 'delay', 'D'));
    expect(freeSlot(p)).toBeNull();
  });
});

function rig() {
  const sent: number[][] = [];
  const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
  const p = new Project();
  p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  return { p, sink, sent };
}

describe('return actions', () => {
  it('add fills lowest slot and names', () => {
    const { p, sink, sent } = rig();
    deleteReturn(p, sink, 'reverb');
    sent.length = 0;
    const r = addReturn(p, sink, 'delay')!;
    expect(r.slot).toBe(0);
    expect(r.name).toBe('Delay 2');
    expect(r.kind).toBe('delay');
    expect(p.mixer.returns.at(-1)).toBe(r);
    expect(p.history!.labels.undo).toBe('Add return');
    expect(addReturn(p, sink, 'reverb', 'Hall')!.name).toBe('Hall');
  });

  it('add refuses at 8', () => {
    const { p, sink } = rig();
    for (let i = 2; i < 8; i++) expect(addReturn(p, sink, 'reverb')).not.toBeNull();
    expect(p.mixer.returns).toHaveLength(8);
    const before = serialize(p);
    expect(addReturn(p, sink, 'delay')).toBeNull();
    expect(serialize(p)).toEqual(before);
  });

  it('rename trims and refuses empty', () => {
    const { p, sink } = rig();
    expect(renameReturn(p, 'reverb', '  Plate  ')).toBe(true);
    expect(p.mixer.returns[0].name).toBe('Plate');
    expect(p.history!.labels.undo).toBe('Rename return');
    const before = serialize(p);
    expect(renameReturn(p, 'reverb', '   ')).toBe(false);
    expect(renameReturn(p, 'reverb', 'x'.repeat(25))).toBe(false);
    expect(renameReturn(p, 'nope', 'ok')).toBe(false);
    expect(serialize(p)).toEqual(before);
    expect(renameReturn(p, 'reverb', 'x'.repeat(24))).toBe(true);
    void sink;
  });

  function loaded() {
    const { p, sink, sent } = rig();
    const a = addDrumTrack(p, sink)!;
    const b = addDrumTrack(p, sink)!;
    const r = addReturn(p, sink, 'reverb')!; // slot 2
    expect(r.slot).toBe(2);
    for (const t of [a, b]) {
      setMix(p, sink, t.id, sendParam(2), -6);
      setMix(p, sink, t.id, sendPreParam(2), 1);
    }
    expect(addLane(p, sink, a.id, { kind: 'mix', param: sendParam(2) })).not.toBeNull();
    expect(addLane(p, sink, r.id, { kind: 'mix', param: 'rev_decay' })).not.toBeNull();
    expect(learnMidi(p, 20, a.id, { kind: 'mix', param: sendParam(2) })).toBe(true);
    expect(learnMidi(p, 21, r.id, { kind: 'mix', param: 'rev_decay' })).toBe(true);
    return { p, sink, sent, a, b, r };
  }

  it('delete then undo restores exactly', () => {
    const { p, sink, a, b, r } = loaded();
    const before = serialize(p);
    expect(deleteReturn(p, sink, r.id)).toBe(true);
    expect(p.history!.labels.undo).toBe('Delete return');
    const after = serialize(p);
    expect(after.mixer.returns.map((x) => x.id)).toEqual(['reverb', 'delay']);
    for (const t of [a, b]) {
      expect(p.mixer.channels[t.id].params[mixParam(sendParam(2)).id]).toBe(mixParam(sendParam(2)).default);
      expect(p.mixer.channels[t.id].params[mixParam(sendPreParam(2)).id]).toBe(mixParam(sendPreParam(2)).default);
    }
    expect(p.mixer.automation).toEqual([]);
    expect(a.automation).toEqual([]);
    expect(p.midiMap).toEqual([]);
    p.history!.undo();
    expect(serialize(p)).toEqual(before);
    p.history!.redo();
    expect(serialize(p)).toEqual(after);
    p.history!.undo(); // never throws
    p.history!.redo();
    expect(serialize(p)).toEqual(after);
  });

  it('delete of an unknown id refuses', () => {
    const { p, sink } = rig();
    expect(deleteReturn(p, sink, 'nope')).toBe(false);
  });

  it('re-add reuses slot clean', () => {
    const { p, sink, sent, a } = loaded();
    deleteReturn(p, sink, p.mixer.returns.find((x) => x.slot === 2)!.id);
    sent.length = 0;
    const n = addReturn(p, sink, 'delay')!;
    expect(n.slot).toBe(2);
    expect(p.mixer.channels[a.id].params[mixParam(sendParam(2)).id]).toBe(mixParam(sendParam(2)).default);
    const kinds = sent.filter((c) => c[0] === Op.RETURN_KIND && c[1] === 2).map((c) => c[2]);
    expect(kinds).toEqual([0, KIND_CODE.delay]);
  });

  it('a master lane on a missing return is skipped, never a TypeError', () => {
    const { p, sink, r } = loaded();
    const withLane = serialize(p);
    expect(masterChannelIndex(withLane.mixer, 'ghost')).toBeNull();
    const ghost = structuredClone(withLane);
    ghost.mixer.automation.push({ ...ghost.mixer.automation[0], lane: 50, channel: 'ghost' });
    expect(() => projectCommands(ghost, new Map())).not.toThrow();
    expect(() => diffApply(p, sink, withLane, ghost)).not.toThrow();
    expect(() => diffApply(p, sink, ghost, withLane)).not.toThrow();
    // undo / redo across a delete (the return's lanes are gone in the "after")
    deleteReturn(p, sink, r.id);
    for (let i = 0; i < 3; i++) expect(() => { p.history!.undo(); p.history!.redo(); }).not.toThrow();
  });
});
