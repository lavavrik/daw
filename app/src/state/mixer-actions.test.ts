import { describe, expect, it } from 'vitest';
import { MAX_KEYS, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, keyCode } from '../audio/protocol';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import { Project } from './project.svelte';
import { addDrumTrack, removeDrumRow, removeTrack } from './actions';
import { banners } from './banners.svelte';
import { addSynthTrack } from './rack-actions';
import {
  DUCK_TO_KICK, DUCK_TO_KICK_V1, duckToKick, kickKey, keyLabel, pickSidechain, rowKeyAllowed, setMix, setSidechain, toggleMute, toggleSolo,
} from './mixer-actions';
import { KIT_ROLES } from './kits';
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

describe('Duck to kick', () => {
  /** A project with a kit-named drum track (Kick on row 0) and a synth; history on. */
  function kitProject() {
    const p = new Project();
    const { sink, sent } = fake();
    const d = addDrumTrack(p, sink, 'Drums', [...KIT_ROLES])!;
    const s = addSynthTrack(p, sink)!;
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    return { p, sink, sent, d, s };
  }
  const comp = (p: Project, id: string) =>
    Object.fromEntries(['comp_on', 'comp_threshold', 'comp_ratio', 'comp_attack', 'comp_release', 'comp_makeup'].map((n) => [n, p.mixer.channels[id].params[P(n)]]));

  it('keys the comp from the Kick row and sets the exact values, one undo entry', () => {
    const { p, sink, sent, d, s } = kitProject();
    setMix(p, sink, s.id, 'fader', -4);
    const before = [...p.mixer.channels[s.id].params];
    sent.length = 0;
    expect(duckToKick(p, sink, s.id)).toEqual({ ok: true });
    expect(p.mixer.channels[s.id].key).toEqual({ trackId: d.id, row: 0 });
    expect(keyLabel(p, p.mixer.channels[s.id].key)).toBe('Drums · Kick');
    expect(comp(p, s.id)).toEqual({ comp_on: 1, comp_threshold: -14, comp_ratio: 8, comp_attack: 1, comp_release: 100, comp_makeup: 0 });
    expect(DUCK_TO_KICK).toEqual({ comp_on: 1, comp_threshold: -14, comp_ratio: 8, comp_attack: 1, comp_release: 100, comp_makeup: 0 });
    expect(sent).toContainEqual([Op.MIX_SET_KEY, s.slot, keyCode({ slot: d.slot, row: 0 }), 0, 0]);
    expect(sent).toContainEqual([Op.MIX_SET, s.slot, P('comp_ratio'), 8, 0]);
    expect(p.mixer.channels[s.id].params[P('fader')]).toBe(-4); // nothing else moves
    expect(p.history!.labels.undo).toBe('Duck to kick');
    p.history!.undo();
    expect([...p.mixer.channels[s.id].params]).toEqual(before);
    expect(p.mixer.channels[s.id].key).toBeNull();
  });

  it('finds the Kick by role (case and spaces ignored), in the first drum track that has one', () => {
    const p = new Project();
    const { sink } = fake();
    addDrumTrack(p, sink, 'Perc', ['Shaker', 'Conga']); // first drum track, no Kick
    const d = addDrumTrack(p, sink, 'Beat', ['Clap', ' kick ', 'Kick'])!;
    const s = addSynthTrack(p, sink)!;
    expect(kickKey(p)).toEqual({ trackId: d.id, row: 1 });
    expect(duckToKick(p, sink, s.id).ok).toBe(true);
    expect(p.mixer.channels[s.id].key).toEqual({ trackId: d.id, row: 1 });
  });

  it('with no Kick row it says so and changes nothing', () => {
    const p = new Project();
    const { sink, sent } = fake();
    addDrumTrack(p, sink); // Row 1..4
    const s = addSynthTrack(p, sink)!;
    const before = [...p.mixer.channels[s.id].params];
    sent.length = 0;
    const r = duckToKick(p, sink, s.id);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no Kick row/i);
    expect(sent).toEqual([]);
    expect([...p.mixer.channels[s.id].params]).toEqual(before);
    expect(p.mixer.channels[s.id].key).toBeNull();
  });

  it(`refuses at MAX_KEYS (${MAX_KEYS}) distinct row keys, and says so; a Kick already keyed is shared`, () => {
    const { p, sink, sent, d } = kitProject();
    // MAX_KEYS other rows, none of them the Kick, each keyed by its own synth.
    const d2 = addDrumTrack(p, sink, 'More', ['A', 'B', 'C', 'D'])!;
    const rows = [...[1, 2, 3, 4, 5, 6, 7].map((row) => ({ trackId: d.id, row })), { trackId: d2.id, row: 0 }];
    expect(rows.length).toBe(MAX_KEYS);
    const keyed = rows.map((key) => {
      const t = addSynthTrack(p, sink)!;
      expect(setSidechain(p, sink, t.id, key)).toBe(true);
      return t;
    });
    const s = addSynthTrack(p, sink)!;
    const label = p.history!.labels.undo;
    sent.length = 0;
    const r = duckToKick(p, sink, s.id);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(String(MAX_KEYS));
    expect(sent).toEqual([]);
    expect(p.mixer.channels[s.id].key).toBeNull();
    expect(p.mixer.channels[s.id].params[P('comp_on')]).toBe(0);
    expect(p.history!.labels.undo).toBe(label);
    // Once a channel holds the Kick row (swapping its own row for it), the next duck shares it: allowed.
    expect(duckToKick(p, sink, keyed[0].id).ok).toBe(true);
    expect(duckToKick(p, sink, s.id).ok).toBe(true);
  });

  it('refuses on the drum track that owns the Kick, on returns and on unknown tracks', () => {
    const { p, sink, sent, d } = kitProject();
    sent.length = 0;
    expect(duckToKick(p, sink, d.id).ok).toBe(false);
    expect(duckToKick(p, sink, 'reverb').ok).toBe(false);
    expect(duckToKick(p, sink, 'gone').ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('without a history (a template build) it just applies', () => {
    const p = new Project();
    const { sink } = fake();
    addDrumTrack(p, sink, 'Drums', [...KIT_ROLES]);
    const s = addSynthTrack(p, sink)!;
    expect(duckToKick(p, sink, s.id).ok).toBe(true);
    expect(p.mixer.channels[s.id].params[P('comp_threshold')]).toBe(-14);
  });

  describe('when the Kick goes away', () => {
    function ducked() {
      const p = new Project();
      const { sink, sent } = fake();
      const d = addDrumTrack(p, sink, 'Drums', [...KIT_ROLES])!;
      const bass = addSynthTrack(p, sink)!;
      bass.name = 'Bass';
      const pad = addSynthTrack(p, sink)!;
      pad.name = 'Pad';
      expect(duckToKick(p, sink, bass.id).ok).toBe(true);
      expect(duckToKick(p, sink, pad.id).ok).toBe(true);
      p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
      banners.hint = null;
      return { p, sink, sent, d, bass, pad };
    }

    it('deleting the Kick row turns off every strip comp still set to Duck to kick, in the same entry, and says so', () => {
      const { p, sink, sent, d, bass, pad } = ducked();
      // The pad's comp was retuned by hand: its own settings, left alone.
      setMix(p, sink, pad.id, 'comp_ratio', 4);
      sent.length = 0;
      expect(removeDrumRow(p, sink, d.id, d.rows[0].id)).toBe(true);
      expect(p.mixer.channels[bass.id].key).toBeNull();
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(0);
      expect(p.mixer.channels[bass.id].params[P('comp_threshold')]).toBe(-14); // only switched off
      expect(sent).toContainEqual([Op.MIX_SET, bass.slot, P('comp_on'), 0, 0]);
      expect(p.mixer.channels[pad.id].key).toBeNull();
      expect(p.mixer.channels[pad.id].params[P('comp_on')]).toBe(1);
      expect(banners.hint).toBe('Duck to kick removed from Bass (kick deleted)');
      expect(p.history!.labels.undo).toBe('Delete row');
      p.history!.undo(); // one step back: the row, the key and the duck
      expect(d.rows[0].name).toBe('Kick');
      expect(p.mixer.channels[bass.id].key).toEqual({ trackId: d.id, row: 0 });
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(1);
    });

    it('deleting the Kick\'s drum track does the same for every ducked strip', () => {
      const { p, sink, d, bass, pad } = ducked();
      removeTrack(p, sink, d.id);
      for (const t of [bass, pad]) {
        expect(p.mixer.channels[t.id].key).toBeNull();
        expect(p.mixer.channels[t.id].params[P('comp_on')]).toBe(0);
      }
      expect(banners.hint).toBe('Duck to kick removed from Bass, Pad (kick deleted)');
      expect(p.history!.labels.undo).toBe('Remove track');
    });

    it('deleting another row, or a strip keyed by hand, changes no comp and says nothing', () => {
      const { p, sink, d, bass } = ducked();
      const s = addSynthTrack(p, sink)!;
      setSidechain(p, sink, s.id, { trackId: d.id, row: 1 });
      setMix(p, sink, s.id, 'comp_on', 1);
      removeDrumRow(p, sink, d.id, d.rows[1].id); // the Clap
      expect(p.mixer.channels[s.id].key).toBeNull();
      expect(p.mixer.channels[s.id].params[P('comp_on')]).toBe(1);
      expect(p.mixer.channels[bass.id].key).toEqual({ trackId: d.id, row: 0 });
      expect(banners.hint).toBeNull();
    });

    it('a strip ducked with the values from before the retune (a saved project) unducks too', () => {
      const { p, sink, d, bass } = ducked();
      for (const [name, v] of Object.entries(DUCK_TO_KICK_V1)) setMix(p, sink, bass.id, name, v);
      removeDrumRow(p, sink, d.id, d.rows[0].id);
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(0);
      expect(p.mixer.channels[bass.id].params[P('comp_threshold')]).toBe(-30);
      expect(banners.hint).toBe('Duck to kick removed from Bass, Pad (kick deleted)');
    });

    it('setting a ducked strip\'s key to none by hand switches its comp off in the same entry; one undo brings both back', () => {
      const { p, sink, sent, d, bass } = ducked();
      sent.length = 0;
      expect(pickSidechain(p, sink, bass.id, null)).toBe(true);
      expect(p.mixer.channels[bass.id].key).toBeNull();
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(0);
      expect(p.mixer.channels[bass.id].params[P('comp_threshold')]).toBe(-14); // only switched off
      expect(sent).toContainEqual([Op.MIX_SET, bass.slot, P('comp_on'), 0, 0]);
      expect(banners.hint).toBe('Duck to kick removed from Bass (sidechain set to none)');
      expect(p.history!.labels.undo).toBe('Sidechain');
      p.history!.undo();
      expect(p.mixer.channels[bass.id].key).toEqual({ trackId: d.id, row: 0 });
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(1);
    });

    it('picking another key, or none on a strip whose comp is its own, leaves the comp alone', () => {
      const { p, sink, d, bass, pad } = ducked();
      expect(pickSidechain(p, sink, bass.id, { trackId: d.id, row: 1 })).toBe(true); // re-keyed: still a duck
      expect(p.mixer.channels[bass.id].params[P('comp_on')]).toBe(1);
      setMix(p, sink, pad.id, 'comp_ratio', 4); // retuned by hand
      expect(pickSidechain(p, sink, pad.id, null)).toBe(true);
      expect(p.mixer.channels[pad.id].params[P('comp_on')]).toBe(1);
      expect(banners.hint).toBeNull();
    });
  });
});
