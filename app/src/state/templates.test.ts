// Project templates (plan 27 Task 2): every template builds from shipped
// content, validates, loads, round-trips and arranges 32 bars as
// state/templates.ts's header says.
import { describe, expect, it } from 'vitest';
import { BAR_TICKS, MAX_KEYS } from '../audio/protocol';
import { inKey } from '../music/scales';
import { loadProject } from '../project/load';
import { validate } from '../project/schema';
import type { DrumTrackJson, ProjectJson, SynthTrackJson } from '../project/schema';
import { serialize } from '../project/serialize';
import { checkLog, fakeDecoder, fakeEngine } from '../project/testFixture';
import { factoryPattern } from './factoryPatterns';
import { SWING_PRESETS } from './groove';
import { KIT_ROLES, kitById } from './kits';
import { DUCK_TO_KICK } from './mixer-actions';
import { presetById } from './mixerPresets';
import { BUILTIN_PATCHES } from './patches';
import { Project } from './project.svelte';
import { addDrumTrack } from './actions';
import { newReturn } from './returns';
import { mixParam } from '../audio/mixerCatalog';
import { ARRANGEMENT, SONG_BARS, TEMPLATES, applyStripMix, buildTemplate, factoryShift, templateById, templateClipCount, templateFromUrl } from './templates';
import type { Template } from './templates';

const roundJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const synths = (j: ProjectJson) => j.tracks.filter((t): t is SynthTrackJson => t.kind === 'synth');
const drumsOf = (j: ProjectJson) => j.tracks.find((t): t is DrumTrackJson => t.kind === 'drum')!;
const byName = (j: ProjectJson, name: string) => j.tracks.find((t) => t.name === name)!;
const mixOf = (j: ProjectJson, name: string) => j.mixer.tracks.find((m) => m.slot === byName(j, name).slot)!;
/** Bars (1-based) where `t` has a clip playing. */
const barsPlayed = (t: { clips: { start: number; len: number }[] }) => {
  const bars = new Set<number>();
  for (const c of t.clips) for (let b = c.start / BAR_TICKS; b < (c.start + c.len) / BAR_TICKS; b++) bars.add(b + 1);
  return bars;
};

describe('the template table', () => {
  it('has the plan\'s four templates, in menu order', () => {
    expect(TEMPLATES.map((t) => [t.name, t.tempo])).toEqual([
      ['Deep House 122', 122], ['Garage 130', 130], ['Acid 126', 126], ['Tech House 125', 125],
    ]);
    expect(TEMPLATES.map((t) => t.key)).toEqual([
      { root: 9, scale: 'minor' }, { root: 5, scale: 'minor' }, { root: 9, scale: 'minor' }, { root: 7, scale: 'minor' },
    ]);
    expect(templateById('garage-130')?.kit).toBe('garage');
    expect(templateById('nope')).toBeUndefined();
  });

  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s names only shipped content', (_, t: Template) => {
    expect(kitById(t.kit)).toBeDefined();
    for (const id of [t.drums.intro, t.drums.groove, t.drums.fill]) expect(factoryPattern(id)?.kind, id).toBe('drum');
    expect(t.drums.fill).toBe('factory-fill-a');
    for (const part of [t.bass, t.chords, t.pad].filter((x) => x !== undefined)) {
      expect(BUILTIN_PATCHES.some((p) => p.name === part.patch), part.patch).toBe(true);
      expect(factoryPattern(part.pattern)?.kind, part.pattern).toBe('synth');
      expect(presetById(part.preset)?.kind, part.preset).toBe('track');
    }
    expect(presetById(t.drums.preset)?.kind).toBe('track');
    expect(presetById(t.reverb)?.kind).toBe('reverb');
    expect(presetById(t.delay)?.kind).toBe('delay');
    expect(presetById(t.master)?.kind).toBe('master');
  });

  it('the factory shift goes the nearer way', () => {
    expect(factoryShift({ root: 9, scale: 'minor' })).toBe(0);
    expect(factoryShift({ root: 5, scale: 'minor' })).toBe(-4); // F minor
    expect(factoryShift({ root: 7, scale: 'minor' })).toBe(-2); // G minor
    expect(factoryShift({ root: 0, scale: 'minor' })).toBe(3); // C minor: up 3, not down 9
  });

  it('an unknown template throws', () => {
    expect(() => buildTemplate('nope')).toThrow(/unknown template/);
  });
});

describe('the templates\' own adjustments', () => {
  const notesOf = (j: ProjectJson, track: string) => (byName(j, track) as SynthTrackJson).patterns[0].notes;
  it('Garage: Speed garage intro; its sub\'s bar 2 sits an octave up (Db2 Eb2 C2), nothing under E1', () => {
    const j = buildTemplate('garage-130');
    expect(templateById('garage-130')!.drums.intro).toBe('factory-speed-garage');
    const bar2 = notesOf(j, 'Bass').filter((n) => n.start >= BAR_TICKS).map((n) => n.pitch);
    expect(bar2).toEqual([37, 37, 39, 36]);
    expect(notesOf(j, 'Bass').filter((n) => n.start < BAR_TICKS).map((n) => n.pitch)).toEqual([29, 29, 32]);
  });
  it('Deep House: the pad plays Am9 Dm9 Fmaj7 Em7, the keys\' order', () => {
    const j = buildTemplate('deep-house-122');
    const lowest = (track: string, bar: number) => Math.min(...notesOf(j, track).filter((n) => Math.floor(n.start / BAR_TICKS) === bar).map((n) => n.pitch));
    const pcs = (track: string, bar: number) => [...new Set(notesOf(j, track).filter((n) => Math.floor(n.start / BAR_TICKS) === bar).map((n) => n.pitch % 12))].sort((a, b) => a - b);
    // Bar by bar the pad's notes are the keys' chord (the same pitch classes).
    for (let bar = 0; bar < 4; bar++) expect(pcs('Pad', bar), `bar ${bar + 1}`).toEqual(pcs('Keys', bar));
    expect(lowest('Pad', 0)).toBe(57);
  });
});

describe.each(TEMPLATES.map((t) => [t.name, t] as const))('%s', (_, t: Template) => {
  const json = buildTemplate(t.id);

  it('validates cleanly (no warnings)', () => {
    const v = validate(roundJson(json));
    expect('error' in v ? v.error : v.warnings).toEqual([]);
  });

  it('sets the tempo, key and name; tracks with kit rows (empty), patches and factory patterns', () => {
    expect([json.name, json.tempo, json.key]).toEqual([t.name, t.tempo, t.key]);
    const names = ['Drums', t.bass.track, t.chords.track, ...(t.pad ? [t.pad.track] : [])];
    expect(json.tracks.map((x) => x.name)).toEqual(names);
    const drums = drumsOf(json);
    expect(drums.rows.map((r) => r.name)).toEqual([...KIT_ROLES]);
    expect(drums.rows.every((r) => r.sample === null)).toBe(true); // they land after the load
    expect(json.samples).toEqual([]);
    expect(drums.patterns.map((p) => p.name).sort()).toEqual(
      [...new Set([t.drums.intro, t.drums.groove, t.drums.fill])].map((id) => factoryPattern(id)!.name).sort(),
    );
    // The step grid opens on the main groove.
    expect(drums.patterns.find((p) => p.engineIdx === drums.currentPattern)!.name).toBe(factoryPattern(t.drums.groove)!.name);
    const parts = [t.bass, t.chords, ...(t.pad ? [t.pad] : [])];
    for (const part of parts) {
      const s = byName(json, part.track) as SynthTrackJson;
      expect(s.patch.name).toBe(part.patch);
      expect(s.patterns.map((p) => p.name)).toEqual([factoryPattern(part.pattern)!.name]); // no empty "Pattern 1"
    }
  });

  it('transposes the factory notes from A minor into its key (plus its bar order and octave fold); every note is in key', () => {
    const shift = factoryShift(t.key);
    for (const part of [t.bass, t.chords, ...(t.pad ? [t.pad] : [])]) {
      const f = factoryPattern(part.pattern)!;
      if (f.kind !== 'synth') throw new Error('synth');
      const got = (byName(json, part.track) as SynthTrackJson).patterns[0].notes;
      const want = f.notes.map((n) => {
        const bar = Math.floor(n.start / BAR_TICKS);
        const start = part.barOrder ? n.start + (part.barOrder.indexOf(bar) - bar) * BAR_TICKS : n.start;
        const pitch = n.pitch + shift < (part.lowest ?? 0) ? n.pitch + shift + 12 : n.pitch + shift;
        return [pitch, start, n.len, n.vel];
      });
      expect(got.map((n) => [n.pitch, n.start, n.len, n.vel])).toEqual(want);
      expect(got.every((n) => inKey(n.pitch, t.key))).toBe(true);
      expect(Math.min(...got.map((n) => n.pitch)), part.track).toBeGreaterThanOrEqual(part.lowest ?? 0);
    }
  });

  it('the fill plays at the main groove\'s swing (the factory Fill A is unchanged)', () => {
    const drums = drumsOf(json);
    const swingOf = (name: string) => drums.patterns.find((p) => p.name === name)!.swing;
    const groove = factoryPattern(t.drums.groove)!;
    expect(swingOf('Fill A')).toBe(groove.kind === 'drum' ? groove.swing : NaN);
    const fill = factoryPattern('factory-fill-a')!;
    expect(fill.kind === 'drum' && fill.swing).toBe(SWING_PRESETS.find((x) => x.mpc === 54)!.swing); // 54 % as shipped
  });

  it('arranges 32 bars: intro thinning in, groove, break (no kick, no bass), drop', () => {
    const clips = json.tracks.flatMap((x): { start: number; len: number }[] => x.clips);
    expect(clips).toHaveLength(templateClipCount(t));
    expect(Math.max(...clips.map((c) => c.start + c.len))).toBe(SONG_BARS * BAR_TICKS);
    expect(Math.min(...clips.map((c) => c.start))).toBe(0);
    const drums = drumsOf(json);
    const patName = (engineIdx: number) => drums.patterns.find((p) => p.engineIdx === engineIdx)!.name;
    const at = (bar: number) => drums.clips.filter((c) => c.start === (bar - 1) * BAR_TICKS).map((c) => patName(c.pattern));
    expect(at(1)).toEqual([factoryPattern(t.drums.intro)!.name]);
    expect(at(5)).toEqual([factoryPattern(t.drums.groove)!.name]);
    expect(at(16)).toEqual(['Fill A']);
    expect(at(24)).toEqual(['Fill A']);
    expect(at(25)).toEqual([factoryPattern(t.drums.groove)!.name]);
    // The break: drums only on its last bar (the fill), no bass; chords throughout.
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const drumBars = barsPlayed(drums);
    expect(range(17, 23).filter((b) => drumBars.has(b))).toEqual([]);
    expect(range(1, 32).filter((b) => !drumBars.has(b))).toEqual(range(17, 23));
    expect([...barsPlayed(byName(json, t.bass.track) as SynthTrackJson)].sort((a, b) => a - b)).toEqual([...range(9, 16), ...range(25, 32)]);
    expect([...barsPlayed(byName(json, t.chords.track) as SynthTrackJson)].sort((a, b) => a - b)).toEqual(range(9, 32));
    if (t.pad) expect([...barsPlayed(byName(json, t.pad.track) as SynthTrackJson)].sort((a, b) => a - b)).toEqual(range(17, 32));
    expect(json.loop).toEqual({ on: false, start: 0, end: SONG_BARS * BAR_TICKS });
    expect(ARRANGEMENT.drums.filter((c) => c.pattern === 'fill').map((c) => c.bar + 1)).toEqual([16, 24]);
  });

  it('mixes: strip presets, faders, sends, Duck to kick on the bass and pad, return and master presets', () => {
    const p = (name: string, param: string) => mixOf(json, name).params[param];
    const kick = drumsOf(json).rows.findIndex((r) => r.name === 'Kick');
    const drumSlot = drumsOf(json).slot;
    const ducked = [t.bass.track, ...(t.pad ? [t.pad.track] : [])];
    for (const name of ducked) {
      expect(mixOf(json, name).key, name).toEqual({ track: drumSlot, row: kick });
      for (const [k, v] of Object.entries(DUCK_TO_KICK)) expect(p(name, k), `${name} ${k}`).toBe(v);
    }
    expect(mixOf(json, t.chords.track).key).toBeNull();
    expect(mixOf(json, 'Drums').key).toBeNull();
    // The strip presets' EQ (the duck leaves EQ alone).
    expect(p('Drums', 'eq_low')).toBe(presetById(t.drums.preset)!.params.eq_low);
    expect(p(t.bass.track, 'eq_hp')).toBe(presetById(t.bass.preset)!.params.eq_hp);
    expect(p(t.chords.track, 'eq_hp')).toBe(presetById(t.chords.preset)!.params.eq_hp);
    if (t.pad) expect(p(t.pad.track, 'eq_hp')).toBe(presetById(t.pad.preset)!.params.eq_hp);
    // Sends: the template's own where it sets one, else the preset's.
    expect(p('Drums', 'send_a')).toBe(t.drums.sends?.reverb ?? presetById(t.drums.preset)!.reverbSend ?? -60);
    expect(p(t.chords.track, 'send_b')).toBe(t.chords.sends?.delay ?? presetById(t.chords.preset)!.delaySend ?? -60);
    // The balance: the template's faders.
    expect(p('Drums', 'fader')).toBe(t.drums.fader);
    for (const part of [t.bass, t.chords, ...(t.pad ? [t.pad] : [])]) expect(p(part.track, 'fader')).toBe(part.fader);
    for (const [ch, id] of [['reverb', t.reverb], ['delay', t.delay], ['master', t.master]] as const) {
      const ps = ch === 'master' ? json.mixer.master : json.mixer.returns.find((r) => r.id === ch)!.params;
      for (const [k, v] of Object.entries(presetById(id)!.params)) expect(ps[k], `${ch} ${k}`).toBe(v);
    }
  });

  it('keys at most MAX_KEYS distinct drum rows', () => {
    const rows = new Set(json.mixer.tracks.flatMap((m) => (m.key && m.key.row !== null ? [`${m.key.track}:${m.key.row}`] : [])));
    expect(rows.size).toBeGreaterThan(0);
    expect(rows.size).toBeLessThanOrEqual(MAX_KEYS);
  });

  it('loads through the real load (a valid engine replay) and round-trips through serialize', async () => {
    const p = new Project();
    const e = fakeEngine();
    expect(await loadProject(p, e, roundJson(json), new Map(), fakeDecoder)).toEqual([]);
    expect(checkLog(e.log).errors).toEqual([]);
    expect(serialize(p)).toEqual(roundJson(json));
    expect(p.tracks.map((x) => x.name)[0]).toBe('Drums');
  });

  it('builds the same project every time', () => {
    expect(buildTemplate(t.id)).toEqual(json);
  });
});

describe('template sends follow the returns (plan 29)', () => {
  it('a project whose first Reverb is on slot 2 gets the template send on send_c', () => {
    const t = TEMPLATES[0];
    const p = new Project();
    p.mixer.returns = [newReturn('echo', 'delay', 'Echo', 1), newReturn('hall', 'reverb', 'Hall', 2)];
    const sink = { send: () => true };
    const track = addDrumTrack(p, sink)!;
    applyStripMix(p, t, track.id, { preset: 'kick-punch', fader: -4, sends: { reverb: -26, delay: -20 } });
    const ps = p.mixer.channels[track.id].params;
    expect(ps[mixParam('send_c').id]).toBe(-26);
    expect(ps[mixParam('send_a').id]).toBe(-60);
    expect(ps[mixParam('send_b').id]).toBe(-20); // the Delay is on slot 1
  });
});

describe('templateFromUrl (?template=<id> at start-up)', () => {
  it('finds a template id', () => {
    expect(templateFromUrl('?template=deep-house-122')).toEqual({ id: 'deep-house-122' });
    expect(templateFromUrl('?x=1&template=acid-126')).toEqual({ id: 'acid-126' });
  });
  it('flags an unknown id', () => {
    expect(templateFromUrl('?template=polka-90')).toEqual({ unknown: 'polka-90' });
  });
  it('is null when absent, empty or "empty"', () => {
    for (const s of ['', '?', '?template=', '?template=%20', '?template=empty', '?other=deep-house-122']) {
      expect(templateFromUrl(s)).toBeNull();
    }
  });
  it('covers every template', () => {
    for (const t of TEMPLATES) expect(templateFromUrl(`?template=${t.id}`)).toEqual({ id: t.id });
  });
});
