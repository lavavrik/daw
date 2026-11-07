import { describe, expect, it } from 'vitest';
import { BAR_TICKS, MAX_NOTES, Op } from '../audio/protocol';
import { Project } from './project.svelte';
import type { SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';
import { selectTrack } from './actions';
import { Recorder, loadRecSettings, recorderFor, saveRecSettings } from './recorder';

/**
 * Fake clock: 1 ms of performance time = 1 tick, and the offset is
 * subtracted like the real clock does (positive offset = earlier).
 * `now` is what heardTicks() returns.
 */
function fakeClock() {
  const c = {
    now: 0,
    heardTicks: () => c.now,
    ticksForEvent: (perfMs: number, offsetMs: number) => perfMs - offsetMs,
  };
  return c;
}

/** Fake actions over plain (non-reactive) tracks; ids are n1, n2, … */
function setup(bars = 1) {
  const clock = fakeClock();
  const mk = (id: string): SynthTrack => ({
    kind: 'synth', id, slot: 0, name: id, color: '', patchName: '', modules: [], cables: [],
    pattern: { bars, notes: [] },
  });
  const tracks = { a: mk('a'), b: mk('b') };
  let target: SynthTrack | null = tracks.a;
  let k = 0;
  const rec = new Recorder({
    clock,
    target: () => target,
    addNote(trackId, o) {
      const t = trackId === 'a' ? tracks.a : tracks.b;
      const n = { id: `n${++k}`, idx: k, ...o };
      t.pattern.notes.push(n);
      return n;
    },
    deleteNotes(trackId, ids) {
      const t = trackId === 'a' ? tracks.a : tracks.b;
      t.pattern.notes = t.pattern.notes.filter((n) => !ids.includes(n.id));
    },
  });
  const notes = (t: SynthTrack = tracks.a) => t.pattern.notes.map(({ pitch, start, len, vel }) => ({ pitch, start, len, vel }));
  return { clock, rec, tracks, notes, setTarget: (t: SynthTrack | null) => (target = t) };
}

/** Arm and start the transport (a pass begins). */
function rolling(s: ReturnType<typeof setup>, ticksNow = 0) {
  s.rec.toggleArm();
  s.rec.onTransport(true, ticksNow);
}

describe('Recorder', () => {
  it('records a note with heard timing and offset', () => {
    const s = setup(4);
    rolling(s);
    s.rec.offsetMs = 10;
    s.rec.noteOn(60, 90, 1010); // heard tick 1000
    s.rec.noteOff(60, 1250); // 1240
    expect(s.notes()).toEqual([{ pitch: 60, start: 1000, len: 240, vel: 90 }]);
    // Position wraps on the pattern period (4 bars = 15360 ticks).
    s.rec.noteOn(62, 100, 15360 + 500 + 10);
    s.rec.noteOff(62, 15360 + 600 + 10);
    expect(s.notes()[1]).toEqual({ pitch: 62, start: 500, len: 100, vel: 100 });
  });

  it('held note across loop end wraps its length', () => {
    const s = setup(1);
    rolling(s);
    s.rec.noteOn(48, 100, 3500);
    s.rec.noteOff(48, BAR_TICKS + 200);
    expect(s.notes()).toEqual([{ pitch: 48, start: 3500, len: 200 + 3840 - 3500, vel: 100 }]);
    // Held for more than a whole loop: cut at the period.
    s.rec.noteOn(50, 100, 2 * BAR_TICKS + 100);
    s.rec.noteOff(50, 4 * BAR_TICKS);
    expect(s.notes()[1]).toEqual({ pitch: 50, start: 100, len: BAR_TICKS, vel: 100 });
  });

  it('stop closes held notes at the stop tick', () => {
    const s = setup(4);
    rolling(s);
    s.rec.noteOn(60, 100, 100);
    s.rec.noteOn(64, 100, 200);
    expect(s.notes()).toEqual([]); // written on release
    s.rec.onTransport(false, 1000);
    expect(s.notes()).toEqual([
      { pitch: 60, start: 100, len: 900, vel: 100 },
      { pitch: 64, start: 200, len: 800, vel: 100 },
    ]);
    // The keys' real note-offs after stop change nothing.
    s.rec.noteOff(60, 5000);
    s.rec.noteOff(64, 5000);
    expect(s.notes()).toHaveLength(2);
    // Disarming also closes (at the heard tick now).
    s.rec.onTransport(true, 0);
    s.rec.noteOn(67, 100, 300);
    s.clock.now = 700;
    s.rec.toggleArm();
    expect(s.rec.armed).toBe(false);
    expect(s.notes()[2]).toEqual({ pitch: 67, start: 300, len: 400, vel: 100 });
  });

  it('no notes during count-in', () => {
    const s = setup(1);
    rolling(s, -BAR_TICKS);
    s.rec.noteOn(60, 100, -500); // in the count-in
    s.rec.noteOff(60, 300); // released after beat 1: still not recorded
    s.rec.noteOn(62, 100, -61); // just before the grace window
    s.rec.noteOff(62, 50);
    expect(s.notes()).toEqual([]);
    s.rec.noteOn(64, 100, 0); // tick 0 counts
    s.rec.noteOff(64, 240);
    expect(s.notes()).toEqual([{ pitch: 64, start: 0, len: 240, vel: 100 }]);
    // Nothing recorded unless armed and playing.
    s.rec.onTransport(false, 300);
    s.rec.noteOn(65, 100, 400);
    s.rec.noteOff(65, 500);
    s.rec.toggleArm(); // disarm
    s.rec.onTransport(true, 0);
    s.rec.noteOn(66, 100, 400);
    s.rec.noteOff(66, 500);
    expect(s.notes()).toHaveLength(1);
  });

  it('overdub skips exact duplicates in one pass', () => {
    const s = setup(1);
    rolling(s);
    s.rec.noteOn(60, 100, 480);
    s.rec.noteOff(60, 720);
    s.rec.noteOn(60, 100, BAR_TICKS + 480); // same pitch + start, next loop
    s.rec.noteOff(60, BAR_TICKS + 600);
    s.rec.noteOn(62, 100, BAR_TICKS + 480); // other pitch, same start: kept
    s.rec.noteOff(62, BAR_TICKS + 600);
    expect(s.notes().map((n) => [n.pitch, n.start])).toEqual([[60, 480], [62, 480]]);
    // A new pass may write it again (merge = overdub on top of the pattern).
    s.rec.onTransport(false, 2 * BAR_TICKS);
    s.rec.onTransport(true, 0);
    s.rec.noteOn(60, 100, 480);
    s.rec.noteOff(60, 720);
    expect(s.notes()).toHaveLength(3);
  });

  it('undo last take removes only that pass\'s notes', () => {
    const s = setup(4);
    rolling(s);
    s.rec.noteOn(60, 100, 0);
    s.rec.noteOff(60, 100);
    s.rec.onTransport(false, 500);
    // Pass 2 records on track a: the target changes without onInputChanged,
    // so the pass keeps its track (see the input-switch test).
    s.rec.onTransport(true, 0);
    s.rec.noteOn(62, 100, 200);
    s.setTarget(s.tracks.b);
    s.rec.noteOff(62, 300);
    s.rec.noteOn(64, 100, 400);
    s.rec.noteOff(64, 500);
    s.rec.onTransport(false, 600);
    expect(s.rec.lastTakeIds).toHaveLength(2);
    // An empty pass does not replace the last take.
    s.rec.onTransport(true, 0);
    s.rec.onTransport(false, 600);
    s.rec.undoLastTake();
    expect(s.notes().map((n) => n.pitch)).toEqual([60]);
    expect(s.notes(s.tracks.b)).toEqual([]);
    expect(s.rec.lastTakeIds).toEqual([]);
    s.rec.undoLastTake(); // nothing left: no-op
    expect(s.notes().map((n) => n.pitch)).toEqual([60]);
  });

  it('arming while playing starts a pass; target is taken at the first recorded note', () => {
    const s = setup(4);
    s.rec.onTransport(true, 0);
    s.rec.noteOn(60, 100, 100);
    s.rec.noteOff(60, 200); // not armed
    s.setTarget(s.tracks.b);
    s.rec.toggleArm();
    s.rec.noteOn(61, 100, 300);
    s.setTarget(s.tracks.a);
    s.rec.noteOff(61, 400);
    expect(s.notes(s.tracks.b).map((n) => n.pitch)).toEqual([61]);
    expect(s.notes()).toEqual([]);
  });

  it('input switch closes held notes at the switch tick and retargets', () => {
    const s = setup(4);
    rolling(s);
    s.rec.noteOn(60, 100, 100); // done before the switch
    s.rec.noteOff(60, 200);
    s.rec.noteOn(62, 100, 300); // held across the switch
    s.rec.sustain(true, 0, 'midi:a');
    s.rec.noteOn(64, 90, 350, 'midi:a');
    s.rec.noteOff(64, 400, 'midi:a'); // pedal-held across the switch
    s.setTarget(s.tracks.b);
    s.rec.onInputChanged(1000);
    // Both close on the old track at the switch tick (the engine cut them there).
    expect(s.notes().map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 100, 100], [62, 300, 700], [64, 350, 650]]);
    // Their real key-up / pedal-up afterwards changes nothing.
    s.rec.noteOff(62, 1500);
    s.rec.sustain(false, 1600, 'midi:a');
    expect(s.notes()).toHaveLength(3);
    // Later notes go to the new input track, as a new take.
    s.rec.noteOn(67, 100, 2000);
    s.rec.noteOff(67, 2100);
    expect(s.notes(s.tracks.b).map((n) => [n.pitch, n.start, n.len])).toEqual([[67, 2000, 100]]);
    expect(s.rec.lastTakeTrackId).toBe('b');
    expect(s.rec.lastTakeIds).toHaveLength(1);
    s.rec.undoLastTake();
    expect(s.notes(s.tracks.b)).toEqual([]);
    expect(s.notes()).toHaveLength(3); // the old track's take is kept
    // Same pitch and start as on the old track: not a duplicate on the new one.
    s.rec.noteOn(60, 100, 100 + 4 * BAR_TICKS);
    s.rec.noteOff(60, 200 + 4 * BAR_TICKS);
    expect(s.notes(s.tracks.b).map((n) => [n.pitch, n.start])).toEqual([[60, 100]]);
    // Switching while stopped or disarmed is harmless.
    s.rec.onTransport(false, 5000);
    s.setTarget(s.tracks.a);
    expect(() => s.rec.onInputChanged(5000)).not.toThrow();
  });

  it('a full pattern is reported once per pass; a vanished track is not "full"', () => {
    let full = 0;
    let room = true;
    const tr: SynthTrack = {
      kind: 'synth', id: 'a', slot: 0, name: 'a', color: '', patchName: '', modules: [], cables: [],
      pattern: { bars: 1, notes: [] },
    };
    const clock = fakeClock();
    const rec = new Recorder({
      clock,
      target: () => tr,
      addNote: () => (room ? { id: 'x' } : null),
      deleteNotes: () => {},
      onFull: () => full++,
    });
    rec.toggleArm();
    rec.onTransport(true, 0);
    room = false;
    rec.noteOn(60, 100, 10);
    rec.noteOff(60, 20); // addNote failed, pattern not full: track gone
    expect(full).toBe(0);
    tr.pattern.notes = Array.from({ length: MAX_NOTES }, (_, i) => ({ id: `${i}`, idx: i, pitch: 0, vel: 1, start: 0, len: 1 }));
    for (const pitch of [61, 62]) {
      rec.noteOn(pitch, 100, 10);
      rec.noteOff(pitch, 20);
    }
    expect(full).toBe(1);
  });

  it('jitter: a note-off mapped a few ticks before its note-on gives len 1, not a whole loop', () => {
    const s = setup(1);
    rolling(s);
    s.rec.noteOn(60, 100, 1000);
    s.rec.noteOff(60, 998); // separate getOutputTimestamp snapshots can disagree slightly
    s.rec.noteOn(62, 100, 2000);
    s.rec.noteOff(62, 1997);
    expect(s.notes().map((n) => n.len)).toEqual([1, 1]);
  });

  it('grace window: a note-on up to 60 ticks before tick 0 snaps to start 0', () => {
    const s = setup(1);
    rolling(s, -BAR_TICKS);
    s.rec.noteOn(60, 100, -60); // a 1/64 early on the downbeat
    s.rec.noteOff(60, 240);
    s.rec.noteOn(62, 100, -61); // earlier than the grace: count-in, dropped
    s.rec.noteOff(62, 240);
    expect(s.notes()).toEqual([{ pitch: 60, start: 0, len: 240, vel: 100 }]);
  });

  it('sustain pedal: a chord played with the pedal ends at pedal-up', () => {
    const s = setup(4);
    rolling(s);
    s.rec.sustain(true, 0, 'midi:a');
    s.rec.noteOn(60, 100, 100, 'midi:a');
    s.rec.noteOn(64, 100, 110, 'midi:a');
    s.rec.noteOn(67, 100, 120, 'qwerty'); // other source: the pedal does not hold it
    s.rec.noteOff(60, 200, 'midi:a');
    s.rec.noteOff(64, 210, 'midi:a');
    s.rec.noteOff(67, 220, 'qwerty');
    expect(s.notes().map((n) => n.pitch)).toEqual([67]);
    s.rec.noteOn(72, 100, 300, 'midi:a'); // still physically held at pedal-up
    s.rec.sustain(false, 1000, 'midi:a');
    expect(s.notes().map((n) => [n.pitch, n.start, n.len])).toEqual([[67, 120, 100], [60, 100, 900], [64, 110, 890]]);
    s.rec.noteOff(72, 1100, 'midi:a'); // pedal up: key-up closes it now
    expect(s.notes().at(-1)).toMatchObject({ pitch: 72, start: 300, len: 800 });
  });

  it('sustain pedal: re-pressing a pedal-held pitch closes the old note there and opens a new one', () => {
    const s = setup(4);
    rolling(s);
    s.rec.sustain(true, 0, 'midi:a');
    s.rec.noteOn(60, 100, 100, 'midi:a');
    s.rec.noteOff(60, 150, 'midi:a');
    s.rec.noteOn(60, 90, 400, 'midi:a');
    expect(s.notes().map((n) => [n.start, n.len])).toEqual([[100, 300]]);
    s.rec.noteOff(60, 450, 'midi:a');
    s.rec.sustain(false, 700, 'midi:a');
    expect(s.notes().map((n) => [n.start, n.len, n.vel])).toEqual([[100, 300, 100], [400, 300, 90]]);
  });

  it('sustain pedal: pedal-held notes close on stop, and panic lifts the pedal', () => {
    const s = setup(4);
    rolling(s);
    s.rec.sustain(true, 0, 'midi:a');
    s.rec.noteOn(60, 100, 100, 'midi:a');
    s.rec.noteOff(60, 150, 'midi:a');
    s.rec.onTransport(false, 500);
    expect(s.notes().map((n) => n.len)).toEqual([400]);
    s.rec.onTransport(true, 0);
    s.rec.noteOn(62, 100, 100, 'midi:a');
    s.rec.noteOff(62, 150, 'midi:a'); // pedal (pressed before this pass) still down
    expect(s.notes()).toHaveLength(1);
    s.clock.now = 300;
    s.rec.closeSource('midi:a'); // panic: closes and forgets the pedal
    expect(s.notes().at(-1)).toMatchObject({ pitch: 62, len: 200 });
    s.rec.noteOn(64, 100, 400, 'midi:a');
    s.rec.noteOff(64, 480, 'midi:a'); // no pedal any more: closes on key-up
    expect(s.notes().at(-1)).toMatchObject({ pitch: 64, len: 80 });
  });

  it('no target synth track: nothing recorded, nothing thrown', () => {
    const s = setup(4);
    s.setTarget(null);
    rolling(s);
    s.rec.noteOn(60, 100, 100);
    s.rec.noteOff(60, 200);
    expect(s.notes()).toEqual([]);
  });

  it('notes are keyed by source: same pitch from two inputs, panic closes one input', () => {
    const s = setup(4);
    rolling(s);
    s.rec.noteOn(60, 100, 100, 'qwerty');
    s.rec.noteOn(60, 80, 150, 'midi:a');
    s.rec.noteOff(60, 300, 'qwerty');
    s.clock.now = 400;
    s.rec.closeSource('midi:a');
    expect(s.notes().map((n) => [n.start, n.len, n.vel])).toEqual([[100, 200, 100], [150, 250, 80]]);
  });

  it('status reflects arm, count-in and recording', () => {
    const s = setup(4);
    expect(s.rec.status().state).toBe('off');
    s.rec.toggleArm();
    expect(s.rec.status().state).toBe('armed');
    s.rec.countIn = true;
    expect(s.rec.countInTicks()).toBe(BAR_TICKS);
    s.rec.onTransport(true, -BAR_TICKS);
    s.clock.now = -100;
    expect(s.rec.status().state).toBe('count-in');
    s.clock.now = 10;
    expect(s.rec.status().state).toBe('recording');
    s.rec.toggleArm();
    expect(s.rec.countInTicks()).toBe(0); // count-in only when armed
  });

  it('offset is clamped to -200..200 and NaN becomes 0', () => {
    const s = setup();
    s.rec.offsetMs = 500;
    expect(s.rec.offsetMs).toBe(200);
    s.rec.offsetMs = NaN;
    expect(s.rec.offsetMs).toBe(0);
  });
});

describe('rec settings', () => {
  it('round-trip through storage; defaults; broken storage is ignored', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadRecSettings(store)).toEqual({ countIn: false, offsetMs: 0 });
    saveRecSettings({ countIn: true, offsetMs: -35 }, store);
    expect(loadRecSettings(store)).toEqual({ countIn: true, offsetMs: -35 });
    m.set('daw.recOffsetMs', 'garbage');
    expect(loadRecSettings(store).offsetMs).toBe(0);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadRecSettings(broken)).toEqual({ countIn: false, offsetMs: 0 });
    expect(() => saveRecSettings({ countIn: true, offsetMs: 0 }, broken)).not.toThrow();
  });
});

describe('recorderFor (real project + actions)', () => {
  it('writes NOTE_SET to the live-input synth track', () => {
    const sent: number[][] = [];
    const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
    const p = new Project();
    const t = addSynthTrack(p, sink)!;
    selectTrack(p, sink, t.id);
    const clock = fakeClock();
    const rec = recorderFor(p, sink, clock);
    rec.toggleArm();
    rec.onTransport(true, 0);
    sent.length = 0;
    rec.noteOn(60, 100, 480);
    rec.noteOff(60, 720);
    expect(t.pattern.notes.map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 480, 240]]);
    expect(sent.map((x) => x[0])).toEqual([Op.NOTE_SET]);
    rec.undoLastTake();
    expect(t.pattern.notes).toEqual([]);
    expect(sent.map((x) => x[0])).toEqual([Op.NOTE_SET, Op.NOTE_REMOVE]);
  });
});
