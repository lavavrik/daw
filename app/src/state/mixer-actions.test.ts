import { describe, expect, it } from 'vitest';
import { MIX_MASTER, MIX_REVERB, Op } from '../audio/protocol';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import { addDrumTrack, removeTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { keyLabel, setMix, setSidechain, toggleMute, toggleSolo } from './mixer-actions';

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
});
