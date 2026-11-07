import { describe, expect, it } from 'vitest';
import { Err, HostErr, Op } from '../audio/protocol';
import { addDrumTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { banners } from './banners.svelte';
import { Project } from './project.svelte';
import { deferSampleAssign, deferSampleLoad, installSampleLoads, pendingSampleLoads } from './sampleLoads';

function fakeEngine() {
  const sent: number[][] = [];
  const e = {
    sampleRate: 48000,
    onSampleLoaded: undefined as ((id: number, code: number) => void) | undefined,
    send(op: number, a = 0, b = 0, c = 0, d = 0) {
      sent.push([op, a, b, c, d]);
      return true;
    },
  };
  return { e, sent };
}

describe('deferred sample loads (session lifetime)', () => {
  it('attaches the sample on settle even if the step grid is gone (synth selected)', () => {
    const p = new Project();
    const { e, sent } = fakeEngine();
    const undo = installSampleLoads(p, e);
    const drums = addDrumTrack(p, e)!;
    deferSampleLoad(7, drums.id, drums.rows[0].id, 'kick');
    expect(banners.notice).toBe('"kick" will load when playback stops');
    addSynthTrack(p, e); // selects the synth: StepGrid would unmount here
    sent.length = 0;
    e.onSampleLoaded!(7, Err.OK);
    expect(drums.rows[0].sampleId).toBe(7);
    expect(drums.rows[0].name).toBe('kick');
    expect(sent).toEqual([[Op.SET_ROW_SAMPLE, drums.slot, 0, 7, 0]]);
    expect(banners.notice).toBeNull();
    expect(pendingSampleLoads()).toBe(0);
    undo();
    expect(e.onSampleLoaded).toBeUndefined();
  });

  it('a failed settle shows an error; the notice clears only when none are left', () => {
    const p = new Project();
    const { e } = fakeEngine();
    const undo = installSampleLoads(p, e);
    const t = addDrumTrack(p, e)!;
    banners.error = null;
    deferSampleLoad(1, t.id, t.rows[0].id, 'a');
    deferSampleLoad(2, t.id, t.rows[1].id, 'b');
    e.onSampleLoaded!(1, Err.OUT_OF_MEMORY);
    expect(banners.error).toBe('Couldn\'t load "a" — not enough memory for this sample');
    expect(banners.notice).not.toBeNull();
    e.onSampleLoaded!(2, Err.OK);
    expect(banners.notice).toBeNull();
    expect(t.rows[0].sampleId).toBeNull();
    expect(t.rows[1].sampleId).toBe(2);
    undo();
  });
  it('a load dropped by an engine reset (project load) settles silently', () => {
    const p = new Project();
    const { e } = fakeEngine();
    const undo = installSampleLoads(p, e);
    const t = addDrumTrack(p, e)!;
    banners.error = null;
    deferSampleLoad(4, t.id, t.rows[0].id, 'a');
    e.onSampleLoaded!(4, HostErr.RESET);
    expect(banners.error).toBeNull();
    expect(banners.notice).toBeNull();
    expect(pendingSampleLoads()).toBe(0);
    expect(t.rows[0].sampleId).toBeNull();
    undo();
  });
});

describe('deferred sample assign (any target)', () => {
  it('runs the attach callback on settle (e.g. a SamplePlayer param)', () => {
    const p = new Project();
    const { e } = fakeEngine();
    const undo = installSampleLoads(p, e);
    const got: number[] = [];
    deferSampleAssign(9, 'kick', (id) => got.push(id));
    expect(banners.notice).toBe('"kick" will load when playback stops');
    e.onSampleLoaded!(9, Err.OK);
    expect(got).toEqual([9]);
    expect(banners.notice).toBeNull();
    deferSampleAssign(10, 'bad', (id) => got.push(id));
    e.onSampleLoaded!(10, Err.OUT_OF_MEMORY);
    expect(got).toEqual([9]);
    expect(banners.error).toMatch(/Couldn't load "bad"/);
    banners.error = null;
    undo();
  });
});
