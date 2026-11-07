import { describe, expect, it } from 'vitest';
import { moduleDef } from '../../audio/catalog';
import { addSynthTrack } from '../../state/rack-actions';
import { addDrumTrack } from '../../state/actions';
import { STARTER_PATCHES } from '../../state/patches';
import { Project } from '../../state/project.svelte';
import type { SynthTrack } from '../../state/project.svelte';
import { laneChoices, moduleTitles, targetLabel } from './autoLabels';

const sink = { send: () => true };

describe('automation lane labels', () => {
  it('names targets as the strip and the rack do', () => {
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES.find((x) => x.name === 'Deep Bass'))! as SynthTrack;
    expect(targetLabel(d, { kind: 'mix', param: 'fader' })).toBe('Fader');
    expect(targetLabel(d, { kind: 'mix', param: 'send_a' })).toBe('Reverb send');
    expect(targetLabel(d, { kind: 'mix', param: 'eq_hp' })).toBe('EQ Low cut');
    expect(targetLabel('master', { kind: 'mix', param: 'limiter_ceiling' })).toBe('Master · Ceiling');
    expect(targetLabel('delay', { kind: 'mix', param: 'delay_feedback' })).toBe('Delay · Feedback');
    // Deep Bass: one filter ("Filter"), two oscillators ("Oscillator 1", "Oscillator 2").
    expect(targetLabel(s, { kind: 'rack', module: 4, param: 'cutoff' })).toBe('Filter · Cutoff');
    expect(targetLabel(s, { kind: 'rack', module: 2, param: 'tune' })).toMatch(/^Oscillator 2 · /);
    expect(moduleTitles([{ idx: 3, kind: moduleDef('osc').kind }, { idx: 1, kind: moduleDef('osc').kind }]).get(1)).toBe('Oscillator 1');
  });

  it('+ Lane offers the continuous targets without a lane', () => {
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const all = laneChoices(d, []).map((x) => x.label);
    expect(all[0]).toBe('Fader');
    expect(all).toContain('Pan');
    expect(all).not.toContain('Mute'); // integer params never
    expect(laneChoices(d, [{ kind: 'mix', param: 'fader' }]).map((x) => x.label)).not.toContain('Fader');
    expect(laneChoices('master', []).map((x) => x.label)).toContain('Master · Ceiling');
  });
});
