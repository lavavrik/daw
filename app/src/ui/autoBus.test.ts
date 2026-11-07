import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { mixParam } from '../audio/mixerCatalog';
import { laneValueAt } from '../state/automation';
import { addLane, addPoint } from '../state/automation-actions';
import { addAudioTrack } from '../state/audio-actions';
import { commandEdits } from '../state/edits';
import { Project } from '../state/project.svelte';
import { createAutoBus } from './autoBus';
import type { AutoView } from './autoBus';

const BAR = 3840;

/** A project with an audio track whose fader has a lane (0: −40 dB, BAR: −20 dB, 2 BAR: −40 dB), and a bus over it. */
function rig() {
  const p = new Project();
  const sent: number[][] = [];
  // Marks edits as App's engine.onCommand does (project.version: the bus's lane cache).
  const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (sent.push([op, a, b, c, d]), commandEdits(p, op), true) };
  const t = addAudioTrack(p, sink)!;
  const lane = addLane(p, sink, t.id, { kind: 'mix', param: 'fader' })!;
  addPoint(p, sink, lane.id, { tick: 0, value: -40 });
  addPoint(p, sink, lane.id, { tick: BAR, value: -20 });
  addPoint(p, sink, lane.id, { tick: 2 * BAR, value: -40 });
  const clock = { heard: 0, engine: 0, block: 0 };
  let suspended = new Set<string>();
  const bus = createAutoBus({
    project: p,
    sink,
    heardTicks: () => clock.heard,
    engineTicks: () => clock.engine,
    blockTicks: () => clock.block,
    onSuspended: (s) => (suspended = s),
    raf: () => 0, // frames are driven by hand
    caf: () => {},
  });
  const views: AutoView[] = [];
  bus.register(t.id, { kind: 'mix', param: 'fader' }, (v) => views.push({ ...v }));
  sent.length = 0;
  return { p, t, lane, sink, sent, clock, bus, views, suspendedSet: () => suspended };
}
const last = (views: AutoView[]) => views[views.length - 1];

describe('autoBus', () => {
  it('ring follows laneValueAt at the heard tick', () => {
    const { p, lane, clock, bus, views } = rig();
    p.mode = 'song';
    p.playing = true;
    for (const tick of [0, 960, 1920, 3000, BAR, 5000, 2 * BAR + 100]) {
      clock.heard = tick;
      clock.engine = tick + 900; // the engine runs ahead (output latency): the HEARD tick is shown
      bus.frame();
      expect(last(views).status).toBe('on');
      expect(last(views).laneId).toBe(lane.id);
      expect(last(views).value).toBeCloseTo(laneValueAt(lane.points, tick, mixParam('fader'))!, 9);
    }
    // Stopped in Song mode: the lane applies at the parked song position.
    p.playing = false;
    p.songPosition = BAR / 2;
    clock.heard = NaN;
    bus.frame();
    expect(last(views)).toMatchObject({ status: 'on', value: -30 });
    // A control without a lane is told so once, and nothing per frame after that.
    const other: AutoView[] = [];
    bus.register(p.tracks[0].id, { kind: 'mix', param: 'pan' }, (v) => other.push(v));
    bus.frame();
    bus.frame();
    expect(other).toEqual([{ status: 'none', value: null, laneId: null }]);
  });

  it('reset (an audio restart) drops suspensions the new engine does not have', () => {
    const { p, t, bus, views, suspendedSet } = rig();
    p.mode = 'song';
    p.playing = false; // stopped: the override lasts until the next jump (until = Infinity)
    bus.frame();
    expect(bus.touch(t.id, { kind: 'mix', param: 'fader' })).toBe(true);
    bus.frame();
    expect(last(views).status).toBe('suspended');
    bus.reset();
    expect(last(views).status).toBe('on');
    expect(suspendedSet().size).toBe(0);
  });

  it('suspended until the next breakpoint', () => {
    const { p, t, lane, sent, clock, bus, views, suspendedSet } = rig();
    p.mode = 'song';
    p.playing = true;
    clock.heard = 1000;
    clock.engine = 1200;
    bus.frame();
    // A manual move: AUTO_OVERRIDE first (the edit's own MIX_SET follows from the caller).
    expect(bus.touch(t.id, { kind: 'mix', param: 'fader' })).toBe(true);
    expect(sent).toEqual([[Op.AUTO_OVERRIDE, lane.lane, 0, 0, 0]]);
    bus.frame();
    expect(last(views)).toMatchObject({ status: 'suspended', value: null, laneId: lane.id });
    expect([...suspendedSet()]).toEqual([lane.id]);
    // Still suspended just before the next point (BAR, after the ENGINE tick 1200) ...
    clock.heard = BAR - 1;
    bus.frame();
    expect(last(views).status).toBe('suspended');
    // ... and the lane takes over once it is heard.
    clock.heard = BAR;
    bus.frame();
    expect(last(views)).toMatchObject({ status: 'on', value: -20 });
    expect(suspendedSet().size).toBe(0);

    // A jump ends it: a loop wrap (the heard tick goes back), Stop, a seek, a mode switch.
    const again = () => {
      bus.touch(t.id, { kind: 'mix', param: 'fader' });
      bus.frame();
      expect(last(views).status).toBe('suspended');
    };
    clock.heard = BAR + 100;
    clock.engine = BAR + 300;
    again();
    clock.heard = 50; // wrapped
    bus.frame();
    expect(last(views).status).toBe('on');
    again();
    p.playing = false; // Stop
    bus.frame();
    expect(last(views).status).toBe('on');
    // Stopped: it lasts until Play or a seek (the engine's rule), not until a point.
    again();
    p.songPosition = 3 * BAR; // seek
    bus.frame();
    expect(last(views).status).toBe('on');
    p.playing = true;
    clock.heard = clock.engine = 100;
    bus.frame();
    again();
    p.mode = 'pattern';
    bus.frame();
    expect(last(views).status).toBe('idle');
    p.mode = 'song';
    bus.frame();
    expect(last(views).status).toBe('on');

    // After the last point there is no next breakpoint: suspended until the next jump.
    clock.heard = 2 * BAR + 10;
    clock.engine = 2 * BAR + 200;
    again();
    clock.heard = 9 * BAR;
    bus.frame();
    expect(last(views).status).toBe('suspended');
  });

  it('pattern mode shows the base', () => {
    const { p, t, lane, sent, clock, bus, views } = rig();
    p.mode = 'pattern';
    p.playing = true;
    clock.heard = 1000;
    bus.frame();
    expect(last(views)).toEqual({ status: 'idle', value: null, laneId: lane.id });
    // A manual move in Pattern mode is just the normal action: no override.
    expect(bus.touch(t.id, { kind: 'mix', param: 'fader' })).toBe(false);
    expect(sent).toEqual([]);
    // A disabled lane, or one without points, shows the base too.
    p.mode = 'song';
    bus.frame();
    expect(last(views).status).toBe('on');
    lane.enabled = false;
    bus.frame();
    expect(last(views)).toEqual({ status: 'idle', value: null, laneId: lane.id });
    expect(bus.touch(t.id, { kind: 'mix', param: 'fader' })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('only continuous targets can be automated; the loop runs only while playing in Song mode with controls', () => {
    const p = new Project();
    const sink = { send: () => true };
    const t = addAudioTrack(p, sink)!;
    let frames = 0;
    const pending: (() => void)[] = [];
    const bus = createAutoBus({
      project: p, sink, heardTicks: () => 0, engineTicks: () => 0, onSuspended: () => {},
      raf: (fn) => (pending.push(() => { frames++; fn(frames * 17); }), pending.length),
      caf: () => { pending.length = 0; },
    });
    expect(bus.canAutomate(t.id, { kind: 'mix', param: 'fader' })).toBe(true);
    expect(bus.canAutomate(t.id, { kind: 'mix', param: 'mute' })).toBe(false);
    expect(bus.canAutomate('master', { kind: 'mix', param: 'limiter_ceiling' })).toBe(true);
    expect(bus.canAutomate(t.id, { kind: 'rack', module: 0, param: 'cutoff' })).toBe(false); // audio track: no rack
    // No loop while stopped, nor without controls.
    p.mode = 'song';
    bus.refresh();
    expect(pending.length).toBe(0);
    p.playing = true;
    bus.refresh();
    expect(pending.length).toBe(0); // nothing registered
    const off = bus.register(t.id, { kind: 'mix', param: 'fader' }, () => {});
    bus.refresh();
    expect(pending.length).toBe(1);
    pending.shift()!();
    expect(frames).toBe(1);
    expect(pending.length).toBe(1); // keeps going while playing
    p.playing = false;
    pending.shift()!();
    expect(pending.length).toBe(0); // stopped: the loop ends
    p.playing = true;
    bus.refresh();
    expect(pending.length).toBe(1);
    off();
    expect(pending.length).toBe(0); // no controls left: the frame is cancelled
  });

  it('the next breakpoint counts from where the engine will be (telemetry tick + one block)', () => {
    const { p, t, clock, bus, views } = rig();
    p.mode = 'song';
    p.playing = true;
    clock.heard = 1000;
    clock.engine = BAR - 20; // the telemetry tick: the override lands a block later, past BAR
    clock.block = 30;
    bus.frame();
    bus.touch(t.id, { kind: 'mix', param: 'fader' });
    clock.heard = BAR + 5;
    bus.frame();
    expect(last(views).status).toBe('suspended'); // BAR was already behind the engine: the next one ends it
    clock.heard = 2 * BAR;
    bus.frame();
    expect(last(views).status).toBe('on');
  });

  it('a loop wrap ends only the suspensions made before it', () => {
    const { p, t, clock, bus, views } = rig();
    p.mode = 'song';
    p.playing = true;
    clock.heard = 3 * BAR;
    bus.frame();
    // The engine has wrapped already (it runs ahead), the heard tick has not: a touch now belongs to the new pass.
    clock.engine = 100;
    bus.touch(t.id, { kind: 'mix', param: 'fader' });
    clock.heard = 3 * BAR + 50; // still the old pass: its ticks are past BAR, but the suspension is the new pass's
    bus.frame();
    expect(last(views).status).toBe('suspended');
    clock.heard = 60; // the wrap is heard: this suspension survives it
    bus.frame();
    expect(last(views).status).toBe('suspended');
    clock.heard = BAR; // and ends at its point
    bus.frame();
    expect(last(views).status).toBe('on');
  });

  it('lanes added later are seen (the lane cache follows project.version); frames are at most 60 per second', () => {
    const { p, t, sink, bus } = rig();
    const pan: AutoView[] = [];
    bus.register(t.id, { kind: 'mix', param: 'pan' }, (v) => pan.push({ ...v }));
    expect(last(pan).status).toBe('none');
    addLane(p, sink, t.id, { kind: 'mix', param: 'pan' });
    bus.frame();
    expect(last(pan).status).toBe('idle');

    // A 120 Hz display: the loop evaluates every other frame.
    let frames = 0;
    const q: ((ts: number) => void)[] = [];
    const p2 = new Project();
    const bus2 = createAutoBus({
      project: p2, sink: { send: () => true }, heardTicks: () => { frames++; return 0; }, engineTicks: () => 0,
      onSuspended: () => {}, raf: (fn) => (q.push(fn), q.length), caf: () => {},
    });
    const t2 = addAudioTrack(p2, { send: () => true })!;
    p2.mode = 'song';
    p2.playing = true;
    bus2.register(t2.id, { kind: 'mix', param: 'fader' }, () => {});
    frames = 0;
    for (let k = 0; k < 12; k++) q.shift()!(k * (1000 / 120));
    expect(frames).toBeLessThanOrEqual(6);
    expect(frames).toBeGreaterThanOrEqual(5);
  });
});
