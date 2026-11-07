import { describe, expect, it } from 'vitest';
import { Err, HostErr, Op } from '../audio/protocol';
import { addDrumTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { banners } from './banners.svelte';
import { Project } from './project.svelte';
import { deferSampleAssign, deferSampleLoad, installSampleLoads, pendingSampleLoads, rebindSampleLoads } from './sampleLoads';

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

describe('deferred sample loads across an audio restart', () => {
  it('rebind moves the handler to the new engine and settles waiting loads from its upload results', () => {
    const p = new Project();
    const { e: old } = fakeEngine();
    const undo = installSampleLoads(p, old);
    const t = addDrumTrack(p, old)!;
    banners.error = null;
    deferSampleLoad(4, t.id, t.rows[0].id, 'kick');
    deferSampleLoad(5, t.id, t.rows[1].id, 'snare');
    deferSampleLoad(6, t.id, t.rows[2].id, 'gone'); // its bytes were not re-uploaded
    const { e: next, sent } = fakeEngine();
    rebindSampleLoads(next, new Map([[4, Err.OK], [5, Err.OUT_OF_MEMORY]]));
    expect(old.onSampleLoaded).toBeUndefined();
    // Uploaded to the new engine: attached through it.
    expect(t.rows[0].sampleId).toBe(4);
    expect(sent).toEqual([[Op.SET_ROW_SAMPLE, t.slot, 0, 4, 0]]);
    expect(banners.error).toMatch(/snare/);
    // Not uploaded at all: dropped (an engine restart never had it).
    expect(t.rows[2].sampleId).toBeNull();
    expect(pendingSampleLoads()).toBe(0);
    expect(banners.notice).toBeNull();
    // Later settles arrive on the new engine.
    deferSampleLoad(8, t.id, t.rows[3].id, 'hat');
    next.onSampleLoaded!(8, Err.OK);
    expect(t.rows[3].sampleId).toBe(8);
    undo();
    expect(next.onSampleLoaded).toBeUndefined();
  });

  it('a deferred import that fails later gives its reserved floats back (a reset does not)', () => {
    const p = new Project();
    const { e } = fakeEngine();
    const undo = installSampleLoads(p, e);
    const t = addDrumTrack(p, e)!;
    // importSample reserved 0.5 s of stereo at 48 kHz for each and recorded its meta.
    for (const id of [21, 22, 23, 24]) p.sampleMeta.set(id, { seconds: 0.5, channels: 2, peaks: null });
    p.arenaFloats = 4 * 48000 + 7;
    for (const id of [21, 22, 23, 24]) deferSampleLoad(id, t.id, t.rows[0].id, `s${id}`);
    e.onSampleLoaded!(21, Err.OK); // loaded: its space stays used
    e.onSampleLoaded!(22, Err.OUT_OF_MEMORY);
    expect(p.arenaFloats).toBe(3 * 48000 + 7);
    e.onSampleLoaded!(23, HostErr.RESET); // a load reset the count itself
    expect(p.arenaFloats).toBe(3 * 48000 + 7);
    // An audio restart settles from its own uploads, which it counted itself:
    // a refusal there was never counted; one still deferred is, at the new rate.
    const { e: e2 } = fakeEngine();
    rebindSampleLoads(e2, new Map([[24, Err.DEFERRED]]));
    p.arenaFloats = 1000 + 48000;
    e2.onSampleLoaded!(24, Err.OUT_OF_MEMORY);
    expect(p.arenaFloats).toBe(1000);
    deferSampleLoad(25, t.id, t.rows[0].id, 's25');
    p.sampleMeta.set(25, { seconds: 1, channels: 1, peaks: null });
    rebindSampleLoads(fakeEngine().e, new Map([[25, Err.OUT_OF_MEMORY]]));
    expect(p.arenaFloats).toBe(1000);
    undo();
  });
});
