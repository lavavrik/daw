import { describe, expect, it } from 'vitest';
import { addSynthTrack } from '../../state/rack-actions';
import { addDrumTrack } from '../../state/actions';
import { STARTER_PATCHES } from '../../state/patches';
import { Project } from '../../state/project.svelte';
import type { SynthTrack } from '../../state/project.svelte';
import { bestMatch, filterGroups, ownerGroups, pickerRows, rowGroups } from './autoPick';
import type { PickGroup } from './autoPick';

const sink = { send: () => true };
const names = (gs: readonly PickGroup[]) => gs.map((g) => g.name);
const labels = (g: PickGroup | undefined) => g?.items.map((x) => x.label);

describe('automation picker groups', () => {
  it('splits a track mixer into Volume / Pan / Sends / EQ / Comp, continuous params only', () => {
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const gs = ownerGroups(d, d.id, []);
    expect(names(gs)).toEqual(['Volume', 'Pan', 'Sends', 'EQ', 'Comp']);
    expect(gs.every((g) => g.section === 'Mixer')).toBe(true);
    expect(labels(gs[0])).toEqual(['Volume']);
    expect(labels(gs[2])).toEqual(['Reverb', 'Delay']); // never the pre switches
    expect(labels(gs[3])).not.toContain('EQ'); // nor EQ on/off
    expect(labels(gs[4])).toContain('Threshold');
    // What the lane header will say, for searching and the tooltip.
    expect(gs[0].items[0].lane).toBe('Fader');
    expect(gs[2].items[0].lane).toBe('Reverb send');
  });

  it('follows the mixer groups with each module, in rack order, by its rack title', () => {
    const p = new Project();
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES.find((x) => x.name === 'Deep Bass'))! as SynthTrack;
    const gs = ownerGroups(s, s.id, []);
    const rack = gs.filter((g) => g.section === 'Rack');
    expect(names(rack)).toContain('Filter');
    expect(names(rack)).toContain('Oscillator 2');
    const order = [...s.modules].sort((a, b) => a.idx - b.idx).map((m) => m.idx);
    const idx = rack.map((g) => Number(g.key.split(':')[2]));
    expect(idx).toEqual(order.filter((i) => idx.includes(i)));
    expect(labels(rack.find((g) => g.name === 'Filter'))).toContain('Cutoff');
  });

  it('marks targets that already have a lane as used', () => {
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const gs = ownerGroups(d, d.id, [{ kind: 'mix', param: 'pan' }]);
    expect(gs.find((g) => g.name === 'Pan')!.items[0].used).toBe(true);
    expect(gs.find((g) => g.name === 'Volume')!.items[0].used).toBe(false);
  });

  it('groups the Master row by channel', () => {
    const p = new Project();
    const gs = rowGroups(p, 'master');
    expect(names(gs)).toEqual(['Master', 'Reverb', 'Delay']);
    expect(labels(gs[0])).toContain('Ceiling');
    expect(labels(gs[0])).toContain('Volume');
    expect(gs[0].items.find((x) => x.label === 'Ceiling')!.owner).toBe('master');
    expect(gs[2].items.every((x) => x.owner === 'delay')).toBe(true);
  });
});

describe('automation picker search', () => {
  const p = new Project();
  const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES.find((x) => x.name === 'Deep Bass'))! as SynthTrack;
  const gs = rowGroups(p, s.id);

  it('keeps everything for an empty query', () => {
    expect(filterGroups(gs, '  ')).toEqual(gs);
  });

  it('filters across groups by param name, case-insensitive', () => {
    const f = filterGroups(gs, 'CUT');
    expect(labels(f.find((g) => g.name === 'Filter'))).toEqual(['Cutoff']);
    expect(labels(f.find((g) => g.name === 'EQ'))).toEqual(['Low cut']);
    expect(f.find((g) => g.name === 'Volume')).toBeUndefined();
  });

  it('a group-name match keeps the whole group', () => {
    const f = filterGroups(gs, 'filter');
    expect(f.find((g) => g.name === 'Filter')!.items.length).toBe(gs.find((g) => g.name === 'Filter')!.items.length);
  });

  it('the best match is a param that starts with the query, then one with a word that does', () => {
    const f = filterGroups(gs, 'cut');
    const rows = pickerRows(f, new Set(f.map((g) => g.key)));
    const at = bestMatch(rows, 'cut');
    const row = rows[at];
    expect(row.kind === 'item' && row.item.label).toBe('Cutoff');
    const q = filterGroups(gs, 'thr');
    const qr = pickerRows(q, new Set(q.map((g) => g.key)));
    const r2 = qr[bestMatch(qr, 'thr')];
    expect(r2.kind === 'item' && r2.item.label).toBe('Threshold');
  });

  it('a group-name search makes its first param the best match', () => {
    const f = filterGroups(gs, 'oscillator 2');
    const rows = pickerRows(f, new Set(f.map((g) => g.key)));
    const r = rows[bestMatch(rows, 'oscillator 2')];
    expect(r.kind === 'item' && `${r.group.name} › ${r.item.label}`).toBe(`Oscillator 2 › ${f[0].items[0].label}`);
  });

  it('never makes a used param the best match', () => {
    const d = addDrumTrack(p, sink)!;
    const used = ownerGroups(d, d.id, [{ kind: 'mix', param: 'pan' }]);
    const f = filterGroups(used, 'pan');
    const rows = pickerRows(f, new Set(f.map((g) => g.key)));
    expect(rows[bestMatch(rows, 'pan')].kind).toBe('group');
  });

  it('lists a collapsed group as its header only', () => {
    const rows = pickerRows(gs, new Set());
    expect(rows.every((r) => r.kind === 'group')).toBe(true);
    const open = pickerRows(gs, new Set([gs[0].key]));
    expect(open.map((r) => r.kind).slice(0, 3)).toEqual(['group', 'item', 'group']);
  });
});
