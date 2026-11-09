import { describe, expect, it } from 'vitest';
import { MIX_DELAY, MIX_MASTER, MIX_REVERB, Op } from '../audio/protocol';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import { addDrumTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { accepts, setMix } from './mixer-actions';
import { MIX_PRESETS, applyPreset, presetById, presetsFor } from './mixerPresets';
import type { PresetKind } from './mixerPresets';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';

function fake() {
  const sent: number[][] = [];
  return { sent, sink: { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } } };
}
const P = (n: string) => mixParam(n).id;
/** The catalog's channel kind and wire index of a preset kind (a track: any slot). */
const CHANNEL: Record<PresetKind, { kind: MixTarget; index: number }> = {
  track: { kind: 'track', index: 0 },
  reverb: { kind: 'return', index: MIX_REVERB },
  delay: { kind: 'return', index: MIX_DELAY },
  master: { kind: 'master', index: MIX_MASTER },
};
function withHistory(p: Project, sink: ReturnType<typeof fake>['sink']) {
  p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
  return p.history;
}

describe('mixer presets: the tables', () => {
  it('has the spec §3 presets per strip kind, in menu order', () => {
    const names = (k: PresetKind) => presetsFor(k).map((x) => x.name);
    expect(names('track')).toEqual(['Kick punch', 'Bass tidy', 'Hats air', 'Pad wash', 'Stab space', 'Lead presence', 'Flat']);
    expect(names('reverb')).toEqual(['Room', 'Plate', 'Hall', 'Dark']);
    expect(names('delay')).toEqual(['1/8 ping-pong', '3/16 dub', '1/4 slap']);
    expect(names('master')).toEqual(['Clean', 'Warm']);
    expect(new Set(MIX_PRESETS.map((x) => x.id)).size).toBe(MIX_PRESETS.length);
  });

  it('every preset value is a catalog param its channel takes, inside the catalog range', () => {
    for (const pr of MIX_PRESETS) {
      const ch = CHANNEL[pr.kind];
      expect(Object.keys(pr.params).length, pr.name).toBeGreaterThan(0);
      for (const [name, v] of Object.entries(pr.params)) {
        const def = MIX_PARAMS.find((d) => d.name === name);
        expect(def, `${pr.name}: ${name}`).toBeDefined();
        expect(accepts(def!, ch.kind, ch.index), `${pr.name}: ${name} on ${pr.kind}`).toBe(true);
        expect(Number.isFinite(v), `${pr.name}: ${name}`).toBe(true);
        expect(v, `${pr.name}: ${name}`).toBeGreaterThanOrEqual(def!.min);
        expect(v, `${pr.name}: ${name}`).toBeLessThanOrEqual(def!.max);
        if (def!.integer) expect(Number.isInteger(v), `${pr.name}: ${name}`).toBe(true);
      }
    }
  });

  it('no preset touches fader, pan, mute or solo', () => {
    for (const pr of MIX_PRESETS) {
      for (const n of ['fader', 'pan', 'mute', 'solo']) expect(pr.params, pr.name).not.toHaveProperty(n);
      for (const n of Object.keys(pr.params)) expect(mixParam(n).group, `${pr.name}: ${n}`).not.toBe('fader');
    }
  });

  it('a preset sets its whole sections: every track preset the EQ, comp and sends; returns their EQ and effect; master its EQ and limiter', () => {
    // So presets are absolute: applying one after another never leaves a
    // knob of the first behind.
    const groups: Record<PresetKind, string[]> = {
      track: ['eq', 'comp', 'send'], reverb: ['eq', 'reverb'], delay: ['eq', 'delay'], master: ['eq', 'limiter'],
    };
    for (const pr of MIX_PRESETS) {
      const want = MIX_PARAMS.filter((d) => groups[pr.kind].includes(d.group)).map((d) => d.name).sort();
      expect(Object.keys(pr.params).sort(), pr.name).toEqual(want);
    }
  });

  it('Flat is the catalog defaults; Hall decays longer than 3 s; master limiters sit at −0.3 dB', () => {
    const flat = presetById('flat')!;
    for (const [n, v] of Object.entries(flat.params)) expect(v, n).toBe(mixParam(n).default);
    expect(presetById('hall')!.params.rev_decay).toBeGreaterThan(3);
    for (const pr of presetsFor('master')) expect(pr.params.limiter_ceiling).toBe(-0.3);
  });
});

describe('applyPreset', () => {
  it('writes the preset params (and sends them), one undo entry "Preset: <name>", undone in one step', () => {
    const p = new Project();
    const { sink, sent } = fake();
    addDrumTrack(p, sink);
    const s = addSynthTrack(p, sink)!;
    const h = withHistory(p, sink);
    setMix(p, sink, s.id, 'fader', -6);
    setMix(p, sink, s.id, 'pan', 0.25);
    const before = [...p.mixer.channels[s.id].params];
    sent.length = 0;
    expect(applyPreset(p, sink, s.id, 'bass-tidy')).toBe(true);
    const bass = presetById('bass-tidy')!;
    const params = p.mixer.channels[s.id].params;
    for (const [n, v] of Object.entries(bass.params)) expect(params[P(n)], n).toBe(v);
    expect(params[P('eq_hp')]).not.toBe(before[P('eq_hp')]);
    expect(params[P('comp_on')]).toBe(1);
    // Fader and pan are the user's: untouched.
    expect(params[P('fader')]).toBe(-6);
    expect(params[P('pan')]).toBe(0.25);
    // Every value reached the engine on the track's slot.
    for (const [n, v] of Object.entries(bass.params)) expect(sent).toContainEqual([Op.MIX_SET, s.slot, P(n), v, 0]);
    expect(h.labels.undo).toBe('Preset: Bass tidy');
    h.undo();
    expect([...p.mixer.channels[s.id].params]).toEqual(before);
    expect(h.labels.undo).toBe('Set Pan');
  });

  it('works on the returns and the master, and only with that strip kind’s presets', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const s = addSynthTrack(p, sink)!;
    expect(applyPreset(p, sink, 'reverb', 'hall')).toBe(true);
    expect(p.mixer.reverb.params[P('rev_decay')]).toBeGreaterThan(3);
    expect(applyPreset(p, sink, 'delay', 'delay-dub')).toBe(true);
    expect(p.mixer.delay.params[P('delay_time')]).toBe(mixParam('delay_time').choices.indexOf('3/16'));
    expect(applyPreset(p, sink, 'master', 'master-warm')).toBe(true);
    expect(p.mixer.master.params[P('eq_on')]).toBe(1);
    sent.length = 0;
    // Wrong kind, unknown preset, unknown channel: refused, nothing sent.
    expect(applyPreset(p, sink, 'reverb', 'bass-tidy')).toBe(false);
    expect(applyPreset(p, sink, 'delay', 'hall')).toBe(false);
    expect(applyPreset(p, sink, s.id, 'master-warm')).toBe(false);
    expect(applyPreset(p, sink, s.id, 'nope')).toBe(false);
    expect(applyPreset(p, sink, 'gone', 'bass-tidy')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('without a history (a template build into a fresh Project) it just applies: no entry', () => {
    const p = new Project();
    const { sink } = fake();
    const s = addSynthTrack(p, sink)!;
    expect(p.history).toBeNull();
    expect(applyPreset(p, sink, s.id, 'pad-wash')).toBe(true);
    expect(p.mixer.channels[s.id].params[P('send_a')]).toBe(presetById('pad-wash')!.params.send_a);
  });

  it('Flat after another preset puts EQ, comp and sends back to the defaults', () => {
    const p = new Project();
    const { sink } = fake();
    const s = addSynthTrack(p, sink)!;
    applyPreset(p, sink, s.id, 'stab-space');
    applyPreset(p, sink, s.id, 'flat');
    expect([...p.mixer.channels[s.id].params]).toEqual(MIX_PARAMS.map((d) => d.default));
  });
});
