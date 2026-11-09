import { describe, expect, it } from 'vitest';
import { moduleDef } from '../../audio/catalog';
import { addSynthTrack } from '../../state/rack-actions';
import { addDrumTrack } from '../../state/actions';
import { STARTER_PATCHES } from '../../state/patches';
import { renameReturn } from '../../state/returns';
import { Project } from '../../state/project.svelte';
import type { SynthTrack } from '../../state/project.svelte';
import { moduleTitles, targetLabel } from './autoLabels';

const sink = { send: () => true };

describe('automation lane labels', () => {
  it('names targets as the strip and the rack do', () => {
    const p = new Project();
    const d = addDrumTrack(p, sink)!;
    const s = addSynthTrack(p, sink, 'Bass', STARTER_PATCHES.find((x) => x.name === 'Deep Bass'))! as SynthTrack;
    expect(targetLabel(p, d, { kind: 'mix', param: 'fader' })).toBe('Fader');
    expect(targetLabel(p, d, { kind: 'mix', param: 'send_a' })).toBe('Reverb send');
    expect(targetLabel(p, d, { kind: 'mix', param: 'eq_hp' })).toBe('EQ Low cut');
    expect(targetLabel(p, 'master', { kind: 'mix', param: 'limiter_ceiling' })).toBe('Master · Ceiling');
    expect(targetLabel(p, 'delay', { kind: 'mix', param: 'delay_feedback' })).toBe('Delay · Feedback');
    // Deep Bass: one filter ("Filter"), two oscillators ("Oscillator 1", "Oscillator 2").
    expect(targetLabel(p, s, { kind: 'rack', module: 4, param: 'cutoff' })).toBe('Filter · Cutoff');
    expect(targetLabel(p, s, { kind: 'rack', module: 2, param: 'tune' })).toMatch(/^Oscillator 2 · /);
    // A send reads "<return name> send"; a send to a return that is not there stays generic.
    renameReturn(p, 'reverb', 'Hall');
    expect(targetLabel(p, d, { kind: 'mix', param: 'send_a' })).toBe('Hall send');
    expect(targetLabel(p, d, { kind: 'mix', param: 'send_e' })).toBe('Send 5');
    // A return's lanes take its name.
    p.mixer.returns[1].name = 'Echo';
    expect(targetLabel(p, 'delay', { kind: 'mix', param: 'delay_feedback' })).toBe('Echo · Feedback');
    expect(moduleTitles([{ idx: 3, kind: moduleDef('osc').kind }, { idx: 1, kind: moduleDef('osc').kind }]).get(1)).toBe('Oscillator 1');
  });
});
