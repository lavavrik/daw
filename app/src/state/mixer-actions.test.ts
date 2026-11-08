import { describe, expect, it } from 'vitest';
import { MAX_KEYS, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op } from '../audio/protocol';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import { addDrumTrack, removeTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { keyLabel, rowKeyAllowed, setMix, setSidechain, toggleMute, toggleSolo } from './mixer-actions';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';

function fake() {
  const sent: number[][] = [];
  return { sent, sink: { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } } };
}
const P = (n: string) => mixParam(n).id;

describe('mixer state', () => {
  it('track add creates a default channel; defaults fill catalog order', () => {
    const p = new Project();
    const { sink } = fake();
    const t = addDrumTrack(p, sink)!;
    expect(p.mixer.channels[t.id].params).toEqual(MIX_PARAMS.map((d) => d.default));
    expect(p.mixer.channels[t.id].key).toBeNull();
    expect(p.mixer.master.params[P('limiter_ceiling')]).toBe(-0.3);
  });

  it('setMix clamps and sends', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    setMix(p, sink, t.id, 'fader', 99);
    setMix(p, sink, t.id, 'fader', -Infinity);
    setMix(p, sink, t.id, 'mute', 0.6);
    setMix(p, sink, 'reverb', 'rev_decay', 99);
    setMix(p, sink, 'master', 'limiter_ceiling', -3);
    setMix(p, sink, t.id, 'fader', NaN);
    expect(sent).toEqual([
      [Op.MIX_SET, 0, P('fader'), 6, 0],
      [Op.MIX_SET, 0, P('fader'), -60, 0],
      [Op.MIX_SET, 0, P('mute'), 1, 0],
      [Op.MIX_SET, MIX_REVERB, P('rev_decay'), mixParam('rev_decay').max, 0],
      [Op.MIX_SET, MIX_MASTER, P('limiter_ceiling'), -3, 0],
      [Op.MIX_SET, 0, P('fader'), 0, 0],
    ]);
    expect(p.mixer.channels[t.id].params[P('mute')]).toBe(1);
  });

  it('setMix ignores unknown params, targets and params that do not apply', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    setMix(p, sink, t.id, 'nope', 1);
    setMix(p, sink, 'missing', 'fader', 1);
    setMix(p, sink, 'master', 'pan', 1);
    setMix(p, sink, t.id, 'limiter_ceiling', -1);
    expect(sent).toEqual([]);
  });

  it('setMix sends reverb params only to the Reverb return, delay params only to the Delay return', () => {
    // Same rule as the engine's MixParam::accepts (catalog.rs): both returns
    // are 'return' channels, but each only takes its own effect's group.
    const p = new Project();
    const { sink, sent } = fake();
    setMix(p, sink, 'delay', 'rev_decay', 2);
    setMix(p, sink, 'reverb', 'delay_feedback', 0.5);
    expect(sent).toEqual([]);
    expect(p.mixer.delay.params[P('rev_decay')]).toBe(mixParam('rev_decay').default);
    expect(p.mixer.reverb.params[P('delay_feedback')]).toBe(mixParam('delay_feedback').default);
    setMix(p, sink, 'reverb', 'rev_decay', 2);
    setMix(p, sink, 'delay', 'delay_feedback', 0.5);
    expect(sent).toEqual([
      [Op.MIX_SET, MIX_REVERB, P('rev_decay'), 2, 0],
      [Op.MIX_SET, MIX_DELAY, P('delay_feedback'), 0.5, 0],
    ]);
  });

  it('solo and mute toggle', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    toggleSolo(p, sink, t.id);
    toggleSolo(p, sink, t.id);
    toggleMute(p, sink, 'delay');
    expect(sent).toEqual([
      [Op.MIX_SET, 0, P('solo'), 1, 0], [Op.MIX_SET, 0, P('solo'), 0, 0], [Op.MIX_SET, 33, P('mute'), 1, 0],
    ]);
  });

  it('exclusive solo: S solos the track and unsolos every other one, in one undo entry', () => {
    // Owner's note (plan 20 task 12): clicking S removes solo from the others.
    const p = new Project();
    const { sink, sent } = fake();
    const [a, b, c] = [addDrumTrack(p, sink)!, addSynthTrack(p, sink)!, addDrumTrack(p, sink)!];
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const solo = (t: { id: string }) => p.mixer.channels[t.id].params[P('solo')];
    toggleSolo(p, sink, a.id, { additive: true });
    toggleSolo(p, sink, c.id, { additive: true });
    expect([solo(a), solo(b), solo(c)]).toEqual([1, 0, 1]);
    sent.length = 0;
    toggleSolo(p, sink, b.id);
    expect([solo(a), solo(b), solo(c)]).toEqual([0, 1, 0]);
    expect(sent).toEqual([
      [Op.MIX_SET, b.slot, P('solo'), 1, 0], [Op.MIX_SET, a.slot, P('solo'), 0, 0], [Op.MIX_SET, c.slot, P('solo'), 0, 0],
    ]);
    expect(p.history.labels.undo).toBe(`Solo ${b.name}`);
    p.history.undo(); // one entry: back to a and c soloed
    expect([solo(a), solo(b), solo(c)]).toEqual([1, 0, 1]);
    p.history.redo();
    // S on a soloed track unsolos just it: a (soloed too) is unchanged.
    toggleSolo(p, sink, a.id, { additive: true });
    sent.length = 0;
    toggleSolo(p, sink, b.id);
    expect([solo(a), solo(b), solo(c)]).toEqual([1, 0, 0]);
    expect(sent).toEqual([[Op.MIX_SET, b.slot, P('solo'), 0, 0]]);
    expect(p.history.labels.undo).toBe(`Unsolo ${b.name}`);
  });

  it('additive solo (Cmd/Ctrl/Shift-click) toggles only that track', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const [a, b] = [addDrumTrack(p, sink)!, addDrumTrack(p, sink)!];
    sent.length = 0;
    toggleSolo(p, sink, a.id, { additive: true });
    toggleSolo(p, sink, b.id, { additive: true });
    toggleSolo(p, sink, a.id, { additive: true });
    expect(sent).toEqual([
      [Op.MIX_SET, a.slot, P('solo'), 1, 0], [Op.MIX_SET, b.slot, P('solo'), 1, 0], [Op.MIX_SET, a.slot, P('solo'), 0, 0],
    ]);
  });

  it('exclusive solo on an unknown track changes nothing', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const a = addDrumTrack(p, sink)!;
    toggleSolo(p, sink, a.id);
    sent.length = 0;
    toggleSolo(p, sink, 'missing');
    expect(sent).toEqual([]);
    expect(p.mixer.channels[a.id].params[P('solo')]).toBe(1);
  });

  it('sidechain encodes slot*32+row+1', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    sent.length = 0;
    setSidechain(p, sink, s.id, { trackId: d.id, row: 2 });
    setSidechain(p, sink, d.id, { trackId: s.id, row: null });
    setSidechain(p, sink, s.id, null);
    expect(sent).toEqual([
      [Op.MIX_SET_KEY, s.slot, d.slot * 32 + 3, 0, 0],
      [Op.MIX_SET_KEY, d.slot, s.slot * 32, 0, 0],
      [Op.MIX_SET_KEY, s.slot, -1, 0, 0],
    ]);
    expect(p.mixer.channels[s.id].key).toBeNull();
  });

  it('a key at the own track is none; invalid keys are ignored', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    setSidechain(p, sink, s.id, { trackId: d.id, row: 0 });
    sent.length = 0;
    setSidechain(p, sink, s.id, { trackId: s.id, row: null });
    expect(sent).toEqual([[Op.MIX_SET_KEY, s.slot, -1, 0, 0]]);
    expect(p.mixer.channels[s.id].key).toBeNull();
    sent.length = 0;
    setSidechain(p, sink, s.id, { trackId: s.id, row: 0 }); // synth has no rows
    setSidechain(p, sink, s.id, { trackId: d.id, row: 99 });
    setSidechain(p, sink, s.id, { trackId: 'gone', row: null });
    expect(sent).toEqual([]);
  });

  it('removeTrack clears keys and deletes the channel', () => {
    const p = new Project();
    const { sink } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    const s2 = addSynthTrack(p, sink)!;
    setSidechain(p, sink, s.id, { trackId: d.id, row: 1 });
    setSidechain(p, sink, s2.id, { trackId: s.id, row: null });
    removeTrack(p, sink, d.id);
    expect(p.mixer.channels[d.id]).toBeUndefined();
    expect(p.mixer.channels[s.id].key).toBeNull();
    expect(p.mixer.channels[s2.id].key).toEqual({ trackId: s.id, row: null });
    removeTrack(p, sink, s.id);
    expect(p.mixer.channels[s2.id].key).toBeNull();
  });

  it('keyLabel', () => {
    const p = new Project();
    const { sink } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    p.tracks[0].kind === 'drum' && (p.tracks[0].rows[0].name = 'kick');
    expect(keyLabel(p, { trackId: d.id, row: 0 })).toBe('Drums · kick');
    expect(keyLabel(p, { trackId: d.id, row: 1 })).toBe('Drums · Row 2');
    expect(keyLabel(p, { trackId: d.id, row: 9 })).toBe('Drums · Row 10');
    expect(keyLabel(p, { trackId: s.id, row: null })).toBe('Synth');
    expect(keyLabel(p, null)).toBe('none');
    expect(keyLabel(p, { trackId: 'gone', row: null })).toBe('none');
  });

  it(`at most MAX_KEYS (${MAX_KEYS}) distinct drum rows are keys: a 9th is refused, sharing or replacing is fine`, () => {
    const p = new Project();
    const { sink, sent } = fake();
    const d1 = addDrumTrack(p, sink)!;
    const d2 = addDrumTrack(p, sink)!;
    const d3 = addDrumTrack(p, sink)!; // 3 x 4 default rows = 12 rows
    const rows = [d1, d2, d3].flatMap((d) => [0, 1, 2, 3].map((row) => ({ trackId: d.id, row })));
    const synths = Array.from({ length: MAX_KEYS + 2 }, () => addSynthTrack(p, sink)!);
    for (let i = 0; i < MAX_KEYS; i++) {
      expect(rowKeyAllowed(p, synths[i].id, rows[i])).toBe(true);
      expect(setSidechain(p, sink, synths[i].id, rows[i])).toBe(true);
    }
    sent.length = 0;
    const ninth = synths[MAX_KEYS];
    expect(rowKeyAllowed(p, ninth.id, rows[MAX_KEYS])).toBe(false);
    expect(setSidechain(p, sink, ninth.id, rows[MAX_KEYS])).toBe(false);
    expect(sent).toEqual([]); // no engine command, state unchanged
    expect(p.mixer.channels[ninth.id].key).toBeNull();
    // A row already in use can be shared; whole tracks and none are always allowed.
    expect(setSidechain(p, sink, ninth.id, rows[0])).toBe(true);
    expect(rowKeyAllowed(p, ninth.id, { trackId: d1.id, row: null })).toBe(true);
    expect(setSidechain(p, sink, synths[MAX_KEYS + 1].id, { trackId: d2.id, row: null })).toBe(true);
    // A channel that alone holds a row may swap it for a new one (its old row is freed).
    expect(rowKeyAllowed(p, synths[MAX_KEYS - 1].id, rows[MAX_KEYS + 1])).toBe(true);
    expect(setSidechain(p, sink, synths[MAX_KEYS - 1].id, rows[MAX_KEYS + 1])).toBe(true);
    // ...but a channel sharing its row with another frees nothing.
    expect(rowKeyAllowed(p, synths[0].id, rows[MAX_KEYS + 2])).toBe(false);
  });

  it('setSidechain reports success', () => {
    const p = new Project();
    const { sink } = fake();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink)!;
    expect(setSidechain(p, sink, s.id, { trackId: d.id, row: 0 })).toBe(true);
    expect(setSidechain(p, sink, s.id, null)).toBe(true);
    expect(setSidechain(p, sink, s.id, { trackId: d.id, row: 99 })).toBe(false);
    expect(setSidechain(p, sink, 'gone', null)).toBe(false);
  });
});
