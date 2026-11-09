import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../audio/catalog';
import { knobColumns, knobSize, paramControl, panelControls } from './controlMap';

const mod = (id: string) => CATALOG.modules.find((m) => m.id === id)!;
const kinds = (id: string) => Object.fromEntries(mod(id).params.map((pd) => [pd.name, paramControl(id, pd)]));

describe('rack control map (plan 21 Task 10)', () => {
  it('envelope A/D/S/R, the Mixer levels, Out, VCA and Noise level are vertical faders', () => {
    expect(kinds('adsr')).toMatchObject({ attack: 'vfader', decay: 'vfader', sustain: 'vfader', release: 'vfader', delay: 'knob', vel_amt: 'knob' });
    expect(kinds('mixer')).toEqual({ lvl1: 'vfader', lvl2: 'vfader', lvl3: 'vfader', lvl4: 'vfader' });
    expect(kinds('out')).toEqual({ level: 'vfader' });
    expect(kinds('vca')).toEqual({ level: 'vfader' });
    expect(kinds('noise')).toEqual({ level: 'vfader', color: 'led' });
  });

  it('a new module\'s 0..1 linear `level` is a fader by the rule; other params are knobs', () => {
    const level = { ...mod('vca').params[0] };
    expect(paramControl('future_thing', level)).toBe('vfader');
    expect(paramControl('future_thing', { ...level, max: 2 })).toBe('knob'); // not a 0..1 level
    expect(paramControl('future_thing', { ...level, name: 'drive' })).toBe('knob');
    expect(kinds('sample_player').gain).toBe('knob'); // 0..2: a gain, not a 0..1 level
  });

  it('choices: 6 or fewer are LED buttons, more a select', () => {
    expect(kinds('filter').mode).toBe('led'); // 6
    expect(kinds('osc').wave).toBe('led'); // 4
    expect(kinds('lfo').division).toBe('select'); // 8
    expect(kinds('delay').division).toBe('select'); // 12
  });

  it('every catalog param gets a control', () => {
    for (const m of CATALOG.modules) for (const pd of m.params) expect(['knob', 'vfader', 'led', 'select'], `${m.id}.${pd.name}`).toContain(paramControl(m.id, pd));
  });

  it('knob sizes: the hero is lg; compact beside faders or in a crowded module; md otherwise', () => {
    expect(knobSize('filter', 'cutoff', { faders: 0, knobs: 4 })).toBe('lg');
    expect(knobSize('lfo', 'rate', { faders: 0, knobs: 2 })).toBe('lg');
    expect(knobSize('sample_player', 'root', { faders: 0, knobs: 6 })).toBe('lg');
    expect(knobSize('filter', 'reso', { faders: 0, knobs: 4 })).toBe('md');
    expect(knobSize('adsr', 'vel_amt', { faders: 4, knobs: 2 })).toBe('sm');
    expect(knobSize('formant', 'f1', { faders: 0, knobs: 10 })).toBe('sm');
  });

  it('knob columns: 1–2 side by side, up to 4 in two columns, up to 9 in three, else four', () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10].map(knobColumns)).toEqual([1, 2, 2, 2, 3, 3, 3, 4]);
  });

  it('panelControls splits a module into choices, faders and knobs (hero first), skipping hidden params', () => {
    const adsr = panelControls(mod('adsr'));
    expect(adsr.faders.map((x) => x.pd.name)).toEqual(['attack', 'decay', 'sustain', 'release']);
    expect(adsr.knobs.map((x) => [x.pd.name, x.size])).toEqual([['delay', 'sm'], ['vel_amt', 'sm']]);
    const filter = panelControls(mod('filter'));
    expect(filter.choices.map((x) => x.pd.name)).toEqual(['mode']);
    expect(filter.knobs.map((x) => [x.pd.name, x.size])).toEqual([['cutoff', 'lg'], ['reso', 'md'], ['cv_amt', 'md'], ['drive', 'md']]);
    expect(filter.cols).toBe(2);
    const sp = mod('sample_player');
    const hidden = sp.params.findIndex((pd) => pd.name === 'sample');
    const spc = panelControls(sp, hidden);
    expect(spc.knobs[0].pd.name).toBe('root');
    expect([...spc.choices, ...spc.faders, ...spc.knobs].some((x) => x.i === hidden)).toBe(false);
    // Indices are the catalog's.
    expect(filter.knobs[0].i).toBe(mod('filter').params.findIndex((pd) => pd.name === 'cutoff'));
  });

  it('note modules (plan 26): Arp rate/mode/latch are LED buttons, octaves and gate knobs; Chord type a select', () => {
    expect(kinds('arp')).toEqual({ rate: 'led', mode: 'led', octaves: 'knob', gate: 'knob', latch: 'led' });
    expect(kinds('chord')).toEqual({ type: 'select', inversion: 'knob' }); // 10 types
    const arp = panelControls(mod('arp'));
    expect(arp.knobs.map((x) => [x.pd.name, x.size])).toEqual([['octaves', 'md'], ['gate', 'md']]);
    expect(mod('arp').inputs.length + mod('arp').outputs.length + mod('chord').inputs.length + mod('chord').outputs.length).toBe(0);
  });
});
