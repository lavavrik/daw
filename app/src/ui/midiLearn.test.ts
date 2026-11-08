import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleDef, paramIndex } from '../audio/catalog';
import { mixParam } from '../audio/mixerCatalog';
import { Op } from '../audio/protocol';
import { diffApply } from '../history/diffApply';
import { createHistory, debugStacks } from '../history/history';
import { serialize } from '../project/serialize';
import { addLane, addPoint } from '../state/automation-actions';
import { addAudioTrack } from '../state/audio-actions';
import { banners } from '../state/banners.svelte';
import { commandEdits } from '../state/edits';
import { learnMidi } from '../state/midiMap';
import { Project } from '../state/project.svelte';
import type { AutoTarget } from '../state/project.svelte';
import { buildFixture } from '../project/testFixture';
import { createAutoBus } from './autoBus';
import { LEARN_HINT, LEARN_TIMEOUT_MS, canLearn, cancelLearn, createCcRouter, isLearning, learning, startLearn } from './midiLearn.svelte';

const CUTOFF = paramIndex(moduleDef('filter'), 'cutoff');
const cutoff: AutoTarget = { kind: 'rack', module: 4, param: 'cutoff' };
const reso: AutoTarget = { kind: 'rack', module: 4, param: 'reso' };
const fader: AutoTarget = { kind: 'mix', param: 'fader' };

/** The fixture (Bass: Filter at module 4), a recording sink, a hand-driven raf and a router over them. */
async function rig() {
  const f = await buildFixture();
  const sent: number[][] = [];
  const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (sent.push([op, a, b, c, d]), true) };
  const frames: (() => void)[] = [];
  const raf = (cb: () => void) => frames.push(cb);
  const frame = () => frames.splice(0).forEach((cb) => cb());
  const touched: unknown[][] = [];
  const clock = { t: 0 };
  const router = createCcRouter({ p: f.p, sink, touch: (o, t) => touched.push([o, t]), raf, now: () => clock.t });
  /** App's history (coalesceTask: one-shot edits in one task merge). */
  const withHistory = () => {
    f.p.history = createHistory({ snapshot: () => serialize(f.p), apply: (from, to) => diffApply(f.p, sink, from, to), coalesceTask: true });
    return f.p.history;
  };
  return { ...f, sent, sink, frames, frame, touched, router, clock, withHistory };
}

beforeEach(() => {
  cancelLearn();
  banners.hint = null;
});
afterEach(() => vi.useRealTimers());

describe('MIDI learn', () => {
  it('learn mode binds the first learnable cc and exits', async () => {
    const { p, synth, router, sent } = await rig();
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    expect(learning()).toEqual({ owner: synth.id, target: cutoff, label: 'Filter Cutoff' });
    expect(isLearning(synth.id, cutoff)).toBe(true);
    expect(isLearning(synth.id, reso)).toBe(false);
    expect(banners.hint).toBe('Move a knob on your MIDI controller (Esc cancels)');
    expect(LEARN_HINT).toBe(banners.hint);
    router.onCc(74, 99);
    expect(p.midiMap).toEqual([{ cc: 74, owner: synth.id, target: cutoff }]);
    expect(learning()).toBeNull();
    expect(banners.hint).toBe('MIDI CC 74 → Filter Cutoff');
    // The learning CC binds; it does not also move the knob.
    expect(sent).toEqual([]);
  });

  it('cc 123 during learn is ignored', async () => {
    const { p, synth, router } = await rig();
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    router.onCc(123, 0);
    router.onCc(120, 0);
    expect(p.midiMap).toEqual([]);
    expect(learning()).not.toBeNull();
    expect(banners.hint).toBe(LEARN_HINT);
    router.onCc(1, 64); // the mod wheel is learnable too
    expect(p.midiMap).toEqual([{ cc: 1, owner: synth.id, target: cutoff }]);
  });

  it('second learn replaces', async () => {
    const { p, synth, router } = await rig();
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    startLearn(synth.id, reso, 'Filter Reso');
    expect(isLearning(synth.id, cutoff)).toBe(false);
    router.onCc(71, 10);
    expect(p.midiMap).toEqual([{ cc: 71, owner: synth.id, target: reso }]);
    expect(learning()).toBeNull();
  });

  it('10 s timeout cancels', async () => {
    vi.useFakeTimers();
    const { p, synth, router } = await rig();
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    vi.advanceTimersByTime(LEARN_TIMEOUT_MS - 1);
    expect(learning()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(LEARN_TIMEOUT_MS).toBe(10_000);
    expect(learning()).toBeNull();
    expect(banners.hint).toBeNull();
    router.onCc(74, 5); // no longer learning, and CC 74 is unmapped: nothing
    expect(p.midiMap).toEqual([]);
    // A second learn restarts the clock (the first one's timer is gone).
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    vi.advanceTimersByTime(6000);
    startLearn(synth.id, reso, 'Filter Reso');
    vi.advanceTimersByTime(6000);
    expect(isLearning(synth.id, reso)).toBe(true);
  });

  it('cancelLearn (Esc) clears the hint; a stale learn target that is gone ends learning', async () => {
    const { p, synth, router } = await rig();
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    cancelLearn();
    expect(learning()).toBeNull();
    expect(banners.hint).toBeNull();
    // Learning a control removed meanwhile binds nothing and ends learn mode.
    startLearn('no-such-track', cutoff, 'Gone');
    router.onCc(74, 1);
    expect(p.midiMap).toEqual([]);
    expect(learning()).toBeNull();
    expect(banners.hint).toBeNull();
  });

  it('router batches three ccs in one frame into one applyCc with the last value', async () => {
    const { p, synth, sink, router, sent, frame, frames } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 7, synth.id, fader);
    void sink;
    router.onCc(74, 0);
    router.onCc(74, 64);
    router.onCc(74, 127);
    expect(sent).toEqual([]); // nothing until the frame
    expect(frames.length).toBe(1); // one frame requested for the burst
    frame();
    const def = moduleDef('filter').params[CUTOFF];
    expect(sent).toEqual([[Op.RACK_SET_PARAM, synth.slot, 4, CUTOFF, def.max]]);
    // Two CCs in one frame: one move each.
    sent.length = 0;
    router.onCc(74, 0);
    router.onCc(7, 127);
    router.onCc(7, 0);
    frame();
    expect(sent).toEqual([
      [Op.RACK_SET_PARAM, synth.slot, 4, CUTOFF, def.min],
      [Op.MIX_SET, synth.slot, mixParam('fader').id, mixParam('fader').min, 0],
    ]);
    // An unmapped CC costs nothing.
    sent.length = 0;
    router.onCc(30, 1);
    frame();
    expect(sent).toEqual([]);
  });

  it('a pause of more than 1 s on a cc ends its sweep: two undo entries', async () => {
    const { p, synth, router, frame, clock, withHistory } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    const h = withHistory();
    const filter = synth.modules.find((m) => m.idx === 4)!;
    const before = filter.params[CUTOFF];
    const tick = async () => {
      frame();
      await Promise.resolve(); // the end of the frame's task (coalesceTask)
    };
    for (const v of [10, 20, 30]) {
      router.onCc(74, v);
      await tick();
      clock.t += 400; // gaps under 1 s: one sweep
    }
    const first = filter.params[CUTOFF];
    expect(debugStacks(h).undo).toHaveLength(1);
    clock.t += 1001;
    router.onCc(74, 120);
    await tick();
    expect(debugStacks(h).undo).toHaveLength(2);
    expect(h.labels.undo).toBe('Set Cutoff (MIDI)');
    h.undo();
    expect(filter.params[CUTOFF]).toBe(first);
    h.undo();
    expect(filter.params[CUTOFF]).toBe(before);
  });

  it('a learn and the next cc move are separate undo entries', async () => {
    const { p, synth, router, frame, withHistory } = await rig();
    const h = withHistory();
    const filter = synth.modules.find((m) => m.idx === 4)!;
    const before = filter.params[CUTOFF];
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    router.onCc(74, 0); // learns (binds only)
    router.onCc(74, 127); // the same task (one MIDI packet): queued for the frame
    await Promise.resolve();
    frame();
    await Promise.resolve();
    expect(debugStacks(h).undo).toHaveLength(2);
    expect(h.labels.undo).toBe('Set Cutoff (MIDI)');
    h.undo();
    expect(filter.params[CUTOFF]).toBe(before);
    expect(h.labels.undo).toBe('MIDI learn CC 74');
    expect(p.midiMap).toHaveLength(1);
    h.undo();
    expect(p.midiMap).toEqual([]);
  });

  it('a learn drops a value of that cc still waiting for the frame', async () => {
    const { p, synth, router, sent, frame } = await rig();
    learnMidi(p, 74, synth.id, reso);
    router.onCc(74, 127); // queued for reso
    startLearn(synth.id, cutoff, 'Filter Cutoff');
    router.onCc(74, 3); // binds 74 to cutoff
    frame();
    expect(sent).toEqual([]); // reso did not move, and the learn did not move cutoff
  });

  it('touch receives the mapping owner and target', async () => {
    const { p, synth, drums, router, touched, frame } = await rig();
    learnMidi(p, 74, synth.id, cutoff);
    learnMidi(p, 7, drums.id, fader);
    router.onCc(74, 3);
    router.onCc(7, 3);
    router.onCc(9, 3); // unmapped
    frame();
    expect(touched).toEqual([[synth.id, cutoff], [drums.id, fader]]);
  });

  it('song mode overrides the lane like a drag; pattern mode just moves the base', () => {
    const p = new Project();
    const sent: number[][] = [];
    const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (sent.push([op, a, b, c, d]), commandEdits(p, op), true) };
    const t = addAudioTrack(p, sink)!;
    const lane = addLane(p, sink, t.id, fader)!;
    addPoint(p, sink, lane.id, { tick: 0, value: -40 });
    addPoint(p, sink, lane.id, { tick: 3840, value: -20 });
    const bus = createAutoBus({
      project: p, sink, heardTicks: () => 0, engineTicks: () => 0, onSuspended: () => {}, raf: () => 0, caf: () => {},
    });
    const frames: (() => void)[] = [];
    const router = createCcRouter({ p, sink, touch: bus.touch, raf: (cb) => frames.push(cb) });
    learnMidi(p, 7, t.id, fader);
    const id = mixParam('fader').id;
    // Pattern mode: the base moves, no override.
    sent.length = 0;
    router.onCc(7, 0);
    frames.splice(0).forEach((cb) => cb());
    expect(sent).toEqual([[Op.MIX_SET, t.slot, id, mixParam('fader').min, 0]]);
    // Song mode: the same move also overrides the lane (AUTO_OVERRIDE), as a knob drag does.
    p.mode = 'song';
    sent.length = 0;
    router.onCc(7, 127);
    frames.splice(0).forEach((cb) => cb());
    expect(sent).toContainEqual([Op.MIX_SET, t.slot, id, 6, 0]);
    expect(sent).toContainEqual([Op.AUTO_OVERRIDE, lane.lane, 0, 0, 0]);
  });

  it('canLearn: continuous and integer knobs, not choices or flags', async () => {
    const { p, synth, drums } = await rig();
    const osc = synth.modules.find((m) => moduleDef(m.kind).id === 'osc')!;
    expect(canLearn(p, synth.id, cutoff)).toBe(true);
    expect(canLearn(p, synth.id, { kind: 'rack', module: osc.idx, param: 'octave' })).toBe(true);
    expect(canLearn(p, synth.id, { kind: 'rack', module: 4, param: 'mode' })).toBe(false); // choice
    expect(canLearn(p, synth.id, { kind: 'rack', module: 99, param: 'cutoff' })).toBe(false); // no such module
    expect(canLearn(p, drums.id, fader)).toBe(true);
    expect(canLearn(p, drums.id, { kind: 'mix', param: 'pan' })).toBe(true);
    for (const flag of ['mute', 'solo', 'eq_on', 'comp_on', 'send_a_pre', 'send_b_pre']) {
      expect(canLearn(p, drums.id, { kind: 'mix', param: flag })).toBe(false);
    }
    expect(canLearn(p, 'delay', { kind: 'mix', param: 'delay_ping_pong' })).toBe(false);
    expect(canLearn(p, 'delay', { kind: 'mix', param: 'delay_time' })).toBe(false); // a choice
    expect(canLearn(p, 'reverb', { kind: 'mix', param: 'rev_size' })).toBe(true);
    expect(canLearn(p, 'master', fader)).toBe(true);
    expect(canLearn(p, 'nope', fader)).toBe(false);
  });
});
