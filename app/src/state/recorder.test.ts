import { describe, expect, it } from 'vitest';
import { BAR_TICKS, MAX_NOTES, Op } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import type { DrumTrack, NotePatternState, SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';
import { addDrumTrack, removeTrack, selectTrack, setStepCount, setTempo } from './actions';
import { makeDrumPattern, newPattern, selectPattern } from './pattern-actions';
import { setMode } from './song-actions';
import { RECORD_LABEL, Recorder, loadRecSettings, recorderFor, saveRecSettings, transportSync, undoTakeTitle } from './recorder';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';

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

/** A plain (non-reactive) synth track with one pattern `${id}0`. */
function mkTrack(id: string, bars: number): SynthTrack {
  return {
    kind: 'synth', id, slot: 0, name: id, color: '', patchName: '', modules: [], cables: [],
    patterns: [{ id: `${id}0`, engineIdx: 0, name: 'Pattern 1', bars, notes: [] }],
    currentPatternId: `${id}0`,
    clips: [],
    automation: [],
  };
}

/** Fake actions over plain (non-reactive) tracks; ids are n1, n2, … */
function setup(bars = 1) {
  const clock = fakeClock();
  const tracks = { a: mkTrack('a', bars), b: mkTrack('b', bars) };
  let target: SynthTrack | null = tracks.a;
  let song = false;
  let k = 0;
  const passes: [pitch: number, pass: number][] = [];
  const pat = (trackId: string, patternId: string) =>
    (trackId === 'a' ? tracks.a : tracks.b).patterns.find((x) => x.id === patternId)!;
  const rec = new Recorder({
    clock,
    target: () => target,
    songMode: () => song,
    addNote(trackId, patternId, o, pass) {
      const n = { id: `n${++k}`, idx: k, ...o };
      pat(trackId, patternId).notes.push(n);
      passes.push([o.pitch, pass]);
      return n;
    },
  });
  const notes = (t: SynthTrack = tracks.a, i = 0) =>
    t.patterns[i].notes.map(({ pitch, start, len, vel }) => ({ pitch, start, len, vel }));
  return { clock, rec, tracks, notes, passes, setTarget: (t: SynthTrack | null) => (target = t), setSong: (v: boolean) => (song = v) };
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
  });

  it('overdub skips exact duplicates across passes (record, quantize, record again)', () => {
    const s = setup(1);
    rolling(s);
    s.rec.noteOn(60, 100, 470);
    s.rec.noteOff(60, 720);
    s.rec.onTransport(false, BAR_TICKS);
    s.tracks.a.patterns[0].notes[0].start = 480; // quantized between the passes
    s.rec.onTransport(true, 0);
    s.rec.noteOn(60, 100, 480); // lands exactly on the quantized note: an invisible stack
    s.rec.noteOff(60, 600);
    s.rec.noteOn(60, 100, 960); // same pitch, new start: kept
    s.rec.noteOff(60, 1000);
    expect(s.notes().map((n) => [n.pitch, n.start])).toEqual([[60, 480], [60, 960]]);
    // A note drawn by hand counts the same as a recorded one.
    s.tracks.a.patterns[0].notes.push({ id: 'drawn', idx: 99, pitch: 64, start: 0, len: 100, vel: 100 });
    s.rec.noteOn(64, 100, BAR_TICKS);
    s.rec.noteOff(64, BAR_TICKS + 50);
    expect(s.notes()).toHaveLength(3);
  });

  it('every note carries its pass number (one undo entry per pass, whatever it retargets to)', () => {
    const s = setup(4);
    rolling(s);
    s.rec.noteOn(60, 100, 0);
    s.rec.noteOff(60, 100);
    s.rec.onTransport(false, 500);
    s.rec.onTransport(true, 0); // pass 2, retargeting mid-pass
    s.rec.noteOn(62, 100, 200);
    s.setTarget(s.tracks.b);
    s.rec.onInputChanged(250);
    s.rec.noteOn(64, 100, 400);
    s.rec.noteOff(64, 500);
    s.rec.onTransport(false, 600);
    s.rec.onTransport(true, 0); // pass 3 (empty)
    s.rec.onTransport(false, 600);
    s.rec.toggleArm();
    s.rec.toggleArm(); // disarm/arm while stopped: no pass
    s.rec.onTransport(true, 0); // pass 4
    s.rec.noteOn(65, 100, 0);
    s.rec.noteOff(65, 10);
    expect(s.passes).toEqual([[60, 1], [62, 2], [64, 2], [65, 4]]);
    expect(s.notes(s.tracks.b).map((n) => n.pitch)).toEqual([64, 65]);
  });

  it('a duplicate that was undone may be recorded again in the same pass', () => {
    const s = setup(1);
    rolling(s);
    s.rec.noteOn(60, 100, 480);
    s.rec.noteOff(60, 720);
    s.tracks.a.patterns[0].notes = []; // undone (the history restored the pattern)
    s.rec.noteOn(60, 100, BAR_TICKS + 480);
    s.rec.noteOff(60, BAR_TICKS + 720);
    expect(s.notes().map((n) => n.start)).toEqual([480]);
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
    // Same pitch and start as on the old track: not a duplicate on the new one.
    s.rec.noteOn(60, 100, 100 + 4 * BAR_TICKS);
    s.rec.noteOff(60, 200 + 4 * BAR_TICKS);
    expect(s.notes(s.tracks.b).map((n) => [n.pitch, n.start])).toEqual([[67, 2000], [60, 100]]);
    // Switching while stopped or disarmed is harmless.
    s.rec.onTransport(false, 5000);
    s.setTarget(s.tracks.a);
    expect(() => s.rec.onInputChanged(5000)).not.toThrow();
  });

  it('a full pattern is reported once per pass; a vanished track is not "full"', () => {
    let full = 0;
    let room = true;
    const tr = mkTrack('a', 1);
    const clock = fakeClock();
    const rec = new Recorder({
      clock,
      target: () => tr,
      addNote: () => (room ? { id: 'x' } : null),
      onFull: () => full++,
    });
    rec.toggleArm();
    rec.onTransport(true, 0);
    room = false;
    rec.noteOn(60, 100, 10);
    rec.noteOff(60, 20); // addNote failed, pattern not full: track gone
    expect(full).toBe(0);
    tr.patterns[0].notes = Array.from({ length: MAX_NOTES }, (_, i) => ({ id: `${i}`, idx: i, pitch: 0, vel: 1, start: 0, len: 1 }));
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

describe('Recorder: patterns and Song mode', () => {
  it('recorder disabled in song mode', () => {
    const s = setup(4);
    s.setSong(true);
    s.rec.toggleArm(); // no-op in Song mode
    expect(s.rec.armed).toBe(false);
    s.setSong(false);
    rolling(s); // armed and playing in Pattern mode
    s.rec.noteOn(60, 100, 100); // held when the mode switches
    s.setSong(true);
    s.rec.onInputChanged(500); // App calls this when the mode changes
    s.rec.noteOff(60, 900);
    expect(s.notes().map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 100, 400]]);
    s.rec.noteOn(62, 100, 1000); // Song mode: nothing records
    s.rec.noteOff(62, 1100);
    expect(s.notes()).toHaveLength(1);
    expect(s.rec.recording()).toBe(false);
    expect(s.rec.status().state).toBe('armed'); // never 'recording' in Song mode
    expect(s.rec.countInTicks()).toBe(0);
    s.rec.toggleArm(); // disarming still works
    expect(s.rec.armed).toBe(false);
  });

  it('a pattern change on the target track closes held notes into the old pattern and starts a new take', () => {
    const s = setup(4);
    const a = s.tracks.a;
    a.patterns.push({ id: 'a1', engineIdx: 1, name: 'Pattern 2', bars: 4, notes: [] });
    rolling(s);
    s.rec.noteOn(60, 100, 100);
    s.rec.noteOff(60, 200);
    s.rec.noteOn(62, 100, 300); // held across the switch
    s.rec.onPatternChanging('b', 900); // another track: ignored
    s.rec.onPatternChanging('a', 1000); // before a's current pattern changes
    a.currentPatternId = 'a1';
    s.rec.noteOff(62, 1500);
    expect(s.notes(a, 0).map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 100, 100], [62, 300, 700]]);
    // Later notes go to the new current pattern as a new take; the same
    // pitch+start as in pattern 0 is not a duplicate there.
    s.rec.noteOn(60, 100, 100 + 4 * BAR_TICKS);
    s.rec.noteOff(60, 200 + 4 * BAR_TICKS);
    expect(s.notes(a, 1).map((n) => [n.pitch, n.start])).toEqual([[60, 100]]);
    // ...but it is one within the same (track, pattern) for the rest of the pass.
    s.rec.noteOn(60, 100, 100 + 8 * BAR_TICKS);
    s.rec.noteOff(60, 200 + 8 * BAR_TICKS);
    expect(s.notes(a, 1)).toHaveLength(1);
  });
});

/** A plain drum track with `rows` rows and one pattern of `stepCount` steps. */
function mkDrum(rows: number, stepCount: 16 | 32 | 64 = 16): DrumTrack {
  const pat = makeDrumPattern(0, 'Pattern 1', stepCount, 0);
  return {
    kind: 'drum', id: 'd', slot: 0, name: 'Drums', color: '',
    rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, name: `Row ${i + 1}`, sampleId: null, gain: 1, pan: 0, mute: false })),
    patterns: [pat],
    currentPatternId: pat.id,
    clips: [],
    automation: [],
  };
}

/** Fake recorder over a drum target; `hits` logs every setStep as [row, step, vel, pass]. */
function drumSetup(rows = 4, stepCount: 16 | 32 | 64 = 16) {
  const clock = fakeClock();
  const drum = mkDrum(rows, stepCount);
  let song = false;
  const hits: [row: string, step: number, vel: number, pass: number][] = [];
  const rec = new Recorder({
    clock,
    target: () => drum,
    songMode: () => song,
    addNote: () => {
      throw new Error('a drum target never gets notes');
    },
    setStep(trackId, patternId, rowId, step, vel, pass) {
      expect([trackId, patternId]).toEqual([drum.id, drum.currentPatternId]);
      hits.push([rowId, step, vel, pass]);
      return true;
    },
  });
  return { clock, rec, drum, hits, setSong: (v: boolean) => (song = v) };
}

describe('Recorder: drum hits (plan 15)', () => {
  it('a hit lands on the nearest step of the current pattern, with its velocity', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 90, 0); // step 0
    s.rec.noteOn(36, 100, 250); // 250 / 240 = 1.04 -> step 1
    s.rec.noteOn(37, 110, 470); // 1.96 -> step 2, row 2 (C#2): early, written once heard (ruling J)
    s.rec.onHeard(480);
    expect(s.hits.map(([r, st, v]) => [r, st, v])).toEqual([['r0', 0, 90], ['r0', 1, 100], ['r1', 2, 110]]);
  });

  it('a hit past the middle of the last step wraps to step 0; later loops wrap too', () => {
    const s = drumSetup(4, 16);
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 15.6 * 240); // last step + 0.6 step: next loop's step 0, ahead (held)
    s.rec.noteOn(36, 100, 15.4 * 240); // still the last step (already sounded: written now)
    s.rec.noteOn(38, 100, 3 * 16 * 240 + 250); // fourth loop, step 1; the held hit is due first
    expect(s.hits.map(([r, st]) => [r, st])).toEqual([['r0', 15], ['r0', 0], ['r2', 1]]);
    // The step count is read at each hit (a 32-step pattern does not wrap at 16).
    s.drum.patterns[0].stepCount = 32;
    s.rec.noteOn(36, 100, 15.6 * 240);
    s.rec.onHeard(16 * 240);
    expect(s.hits.at(-1)!.slice(0, 2)).toEqual(['r0', 16]);
  });

  it('swing: a hit snaps to the nearest step of the swung grid (odd steps late by swing/2 step)', () => {
    // Plan 15 ruling I. Swing 0.5: step 1 sounds at 240 + 60 = 300.
    const s = drumSetup(4, 16);
    s.drum.patterns[0].swing = 0.5;
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 370); // round -> 2, but 300 (step 1) is nearer than 480
    s.rec.noteOn(36, 100, 420); // 480 (step 2) is nearer than 300
    s.rec.noteOn(36, 100, 15 * 240 + 60 + 50); // 3770: nearer the swung last step (3720) than 3840: 15
    s.rec.noteOn(36, 100, 15 * 240 + 60 + 150); // nearer the next loop's step 0 (3840): 0
    s.rec.noteOn(36, 100, 3 * 16 * 240 + 300); // fourth loop, step 1 on the swung grid
    expect(s.hits.map(([, st]) => st)).toEqual([1, 2, 15, 0, 1]);
    // Swing 0: the plain grid (370 -> 2).
    s.drum.patterns[0].swing = 0;
    s.rec.noteOn(36, 100, 370);
    s.rec.onTransport(false, 400); // stop flushes the held hit
    expect(s.hits.at(-1)![1]).toBe(2);
  });

  it('a velocity-0 note-on is no hit (it would erase the step)', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 0, 240);
    expect(s.hits).toEqual([]);
  });

  it('only notes 36.. for rows the track has record; note-offs and the pedal change nothing', () => {
    const s = drumSetup(4);
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(60, 100, 0); // not a drum note
    s.rec.noteOn(35, 100, 0); // below row 1
    s.rec.noteOn(40, 100, 0); // row 5: the track has 4
    s.rec.noteOn(52, 100, 0); // past row 16
    s.rec.noteOn(39, 100, 240); // row 4: recorded
    s.rec.noteOff(39, 300);
    s.rec.sustain(true, 300);
    s.rec.sustain(false, 400);
    s.rec.onTransport(false, 500);
    expect(s.hits.map(([r, st]) => [r, st])).toEqual([['r3', 1]]);
  });

  it('nothing records in Song mode, unarmed, stopped or during the count-in', () => {
    const s = drumSetup();
    s.rec.noteOn(36, 100, 0); // not armed
    s.rec.toggleArm();
    s.rec.noteOn(36, 100, 0); // stopped
    s.rec.onTransport(true, -BAR_TICKS);
    s.rec.noteOn(36, 100, -500); // count-in
    s.setSong(true);
    s.rec.noteOn(36, 100, 240); // Song mode
    expect(s.hits).toEqual([]);
    s.setSong(false);
    s.rec.noteOn(36, 100, -30); // grace window: step 0
    expect(s.hits.map(([r, st]) => [r, st])).toEqual([['r0', 0]]);
  });

  it('every hit of a pass carries the pass number (one undo entry per pass)', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 0);
    s.rec.noteOn(37, 100, 480);
    s.rec.onTransport(false, 600);
    s.rec.onTransport(true, 0);
    s.rec.noteOn(38, 100, 0);
    const passes = s.hits.map((h) => h[3]);
    expect(passes[0]).toBe(passes[1]);
    expect(passes[2]).toBe(passes[0] + 1);
  });

  // Ruling J: a hit a little before its step must not flam. Written at once,
  // the engine would also play the new step a moment later (the user just
  // heard their own live hit), so it is held until the heard clock passes
  // the step's (swung, unwrapped) tick.
  it('an early hit is held until the heard tick reaches its step; a late one is written at once', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 230); // step 1 (240) is 10 ticks ahead
    expect(s.hits).toEqual([]);
    s.rec.onHeard(200);
    s.rec.onHeard(239);
    expect(s.hits).toEqual([]);
    s.rec.onHeard(240);
    expect(s.hits.map(([r, st, v]) => [r, st, v])).toEqual([['r0', 1, 100]]);
    s.rec.onHeard(300); // written once
    expect(s.hits).toHaveLength(1);
    s.rec.noteOn(37, 90, 490); // step 2 (480) has sounded: at once
    expect(s.hits.at(-1)!.slice(0, 3)).toEqual(['r1', 2, 90]);
  });

  it('the swung tick decides: an odd step is held until its late tick', () => {
    const s = drumSetup();
    s.drum.patterns[0].swing = 0.5; // step 1 at 300
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 280);
    s.rec.onHeard(299);
    expect(s.hits).toEqual([]);
    s.rec.onHeard(300);
    expect(s.hits.map(([, st]) => st)).toEqual([1]);
  });

  it('held hits are flushed at Stop, disarm and a retarget, in the same pass (one undo entry)', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    s.rec.onTransport(true, 0);
    s.rec.noteOn(36, 100, 0); // written now
    s.rec.noteOn(37, 100, 470); // held (step 2 at 480)
    s.rec.onTransport(false, 475); // Stop before the heard clock got there
    expect(s.hits.map(([r, st]) => [r, st])).toEqual([['r0', 0], ['r1', 2]]);
    expect(s.hits[1][3]).toBe(s.hits[0][3]); // same pass
    s.rec.onTransport(true, 0);
    s.rec.noteOn(38, 100, 230);
    s.rec.toggleArm(); // disarm
    expect(s.hits.at(-1)!.slice(0, 2)).toEqual(['r2', 1]);
    expect(s.hits.at(-1)![3]).toBe(s.hits[0][3] + 1);
    s.rec.toggleArm();
    s.rec.noteOn(39, 100, 1000); // step 4 at 960: late, now
    s.rec.noteOn(39, 100, 1190); // step 5 at 1200: held
    s.rec.onPatternChanging('d', 1195); // flushed before the switch (old pattern)
    expect(s.hits.at(-1)!.slice(0, 2)).toEqual(['r3', 5]);
    expect(s.hits.at(-1)![3]).toBe(s.hits.at(-2)![3]);
  });

  it('Undo take writes held hits first, so it undoes them with the pass', () => {
    const s = drumSetup();
    let undone = 0;
    const rec = new Recorder({
      clock: s.clock,
      target: () => s.drum,
      addNote: () => null,
      setStep: (_t, _p, rowId, step, vel, pass) => {
        s.hits.push([rowId, step, vel, pass]);
        return true;
      },
      undoPass: () => {
        undone = s.hits.length;
        return true;
      },
    });
    rec.toggleArm();
    rec.onTransport(true, 0);
    rec.noteOn(36, 100, 230);
    rec.undoLastTake();
    expect(undone).toBe(1);
  });
});

describe('transportSync (App\'s per-frame telemetry watcher)', () => {
  it('each playing frame releases held drum hits whose step the heard clock reached', () => {
    const s = drumSetup();
    s.rec.toggleArm();
    const sync = transportSync(s.rec);
    s.rec.onTransport(true, 0);
    sync(true, true, () => 100);
    s.rec.noteOn(36, 100, 230);
    sync(true, true, () => 235);
    expect(s.hits).toEqual([]);
    sync(true, true, () => 241);
    expect(s.hits.map(([, st]) => st)).toEqual([1]);
  });

  it('UI Play starts the pass at once; frames before the engine confirms do not end it', () => {
    const s = setup(4);
    s.rec.toggleArm();
    const sync = transportSync(s.rec);
    // transportToggle: Play sent, recorder told directly (no frame of lag).
    s.rec.onTransport(true, 0);
    s.rec.noteOn(60, 100, 5); // played right on Play
    sync(false, true, () => -3); // engine has not applied PLAY yet
    sync(false, true, () => -3);
    expect(s.rec.playing).toBe(true);
    sync(true, true, () => 50); // confirmed (idempotent)
    s.rec.noteOff(60, 100);
    expect(s.notes()).toEqual([{ pitch: 60, start: 5, len: 95, vel: 100 }]);
  });

  it('the engine starting on its own starts a pass; stopping on its own ends it at the last heard tick', () => {
    const s = setup(4);
    s.rec.toggleArm();
    const sync = transportSync(s.rec);
    sync(true, true, () => 10);
    expect(s.rec.playing).toBe(true);
    s.rec.noteOn(62, 100, 100);
    sync(true, true, () => 400);
    sync(false, true, () => 0); // console STOP / engine failure: playhead reset to 0
    expect(s.rec.playing).toBe(false);
    expect(s.notes()).toEqual([{ pitch: 62, start: 100, len: 300, vel: 100 }]);
    // Engine says playing but the UI already stopped (Stop not applied yet): no restart.
    sync(true, false, () => 500);
    expect(s.rec.playing).toBe(false);
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
  /** A project with a synth track, the history installed as App does, and a wired recorder. */
  function rig() {
    const sent: number[][] = [];
    const sink = { send(op: number, a = 0, b = 0, c = 0, d = 0) { sent.push([op, a, b, c, d]); return true; } };
    const p = new Project();
    const t = addSynthTrack(p, sink)!;
    selectTrack(p, sink, t.id);
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const clock = fakeClock();
    const rec = recorderFor(p, sink, clock);
    p.beforePatternSwitch = (id) => rec.onPatternChanging(id, clock.heardTicks()); // as App wires it
    return { sent, sink, p, t, clock, rec, h: p.history };
  }

  it('writes NOTE_SET to the live-input synth track; Undo take undoes the pass', () => {
    const { sent, t, rec, h } = rig();
    rec.toggleArm();
    rec.onTransport(true, 0);
    sent.length = 0;
    expect(rec.status().canUndoTake).toBe(false);
    rec.noteOn(60, 100, 480);
    rec.noteOff(60, 720);
    expect(currentPattern(t).notes.map((n) => [n.pitch, n.start, n.len])).toEqual([[60, 480, 240]]);
    expect(sent.map((x) => x[0])).toEqual([Op.NOTE_SET]);
    expect(rec.status().canUndoTake).toBe(true);
    expect(h.labels.undo).toBe(RECORD_LABEL);
    rec.undoLastTake();
    expect(currentPattern(t).notes).toEqual([]);
    expect(sent.map((x) => x[0])).toEqual([Op.NOTE_SET, Op.NOTE_REMOVE]);
    expect(rec.status().canUndoTake).toBe(false);
    expect(h.labels.redo).toBe(RECORD_LABEL); // Cmd+Shift+Z brings the take back
  });

  it('a recording pass is one undo entry, across a pattern switch', () => {
    const { sent, sink, p, t, clock, rec, h } = rig();
    const [p0] = t.patterns;
    const p1 = newPattern(p, sink, t.id) as NotePatternState;
    rec.toggleArm();
    rec.onTransport(true, 0);
    rec.noteOn(60, 100, 100);
    rec.noteOff(60, 200);
    rec.noteOn(62, 100, 480);
    clock.now = 960;
    selectPattern(p, sink, t.id, p0.id); // mid-note: 62 closes into p1
    rec.noteOff(62, 1200);
    rec.noteOn(64, 100, 1300);
    rec.noteOff(64, 1400); // into p0, same pass
    expect(p1.notes.map((n) => [n.pitch, n.len])).toEqual([[60, 100], [62, 480]]);
    expect(p0.notes.map((n) => n.pitch)).toEqual([64]);
    sent.length = 0;
    rec.undoLastTake();
    expect([p0.notes, p1.notes]).toEqual([[], []]);
    // The pass began on p1: the engine edits p0's notes, then goes back to p1.
    expect(t.currentPatternId).toBe(p1.id);
    expect(h.labels.undo).toBe('New pattern');
    expect(rec.status().canUndoTake).toBe(false);
  });

  it('Undo take only undoes a pass that is the newest entry', () => {
    const { sink, p, t, rec, h } = rig();
    rec.toggleArm();
    rec.onTransport(true, 0);
    rec.noteOn(60, 100, 100);
    rec.noteOff(60, 200);
    rec.onTransport(false, 300); // the pass ends (an edit during it would join it)
    removeTrack(p, sink, t.id);
    expect(rec.status().canUndoTake).toBe(false);
    rec.undoLastTake(); // not a pass on top: nothing
    expect(p.tracks).toEqual([]);
    h.undo(); // the removal
    expect(rec.status().canUndoTake).toBe(true);
    rec.undoLastTake();
    expect(currentPattern(p.tracks[0] as SynthTrack).notes).toEqual([]);
    // Song mode: arming is a no-op.
    rec.toggleArm();
    setMode(p, sink, 'song');
    rec.toggleArm();
    expect(rec.armed).toBe(false);
  });
  it('undo take undoes edits made during it', () => {
    const { sink, p, t, rec, h } = rig();
    const tempo = p.tempo;
    rec.toggleArm();
    rec.onTransport(true, 0);
    setTempo(p, sink, 100); // before the pass's first note: its own entry
    rec.noteOn(60, 100, 100);
    rec.noteOff(60, 200);
    setTempo(p, sink, 140); // mid-pass: joins the take
    rec.noteOn(62, 100, 300);
    rec.noteOff(62, 400);
    const st = rec.status();
    expect(st.canUndoTake).toBe(true);
    expect(st.takeEdits).toBe(1);
    expect(undoTakeTitle(st.takeEdits)).toBe('Undo take (also undoes 1 edit made during it)');
    expect(undoTakeTitle(2)).toBe('Undo take (also undoes 2 edits made during it)');
    expect(undoTakeTitle(3)).toBe('Undo take (also undoes 3 edits made during it)');
    expect(undoTakeTitle(0)).toMatch(/^Undo take: /);
    expect(h.labels.undo).toBe(RECORD_LABEL);
    rec.undoLastTake();
    expect(currentPattern(t).notes).toEqual([]);
    expect(p.tempo).toBe(100);
    expect(h.labels.undo).toBe('Tempo');
    // Undo take ended the pass's hold; Stop does too.
    h.redo();
    rec.onTransport(false, 500);
    setTempo(p, sink, 150);
    expect(h.labels.undo).toBe('Tempo');
    expect(rec.status()).toMatchObject({ canUndoTake: false, takeEdits: 0 });
    h.undo();
    expect(p.tempo).toBe(140);
    expect(tempo).not.toBe(140);
  });

  it('a drum input track: hits write SET_STEP into its current pattern, one "Record" entry per pass', () => {
    const { sent, sink, p, rec, h } = rig();
    const d = addDrumTrack(p, sink)!; // selected: the live input
    setStepCount(p, sink, d.id, 32);
    rec.toggleArm();
    rec.onTransport(true, 0);
    sent.length = 0;
    rec.noteOn(36, 90, 250); // row 1, step 1
    rec.noteOn(39, 127, 32 * 240 + 470); // row 4, second loop, step 2
    rec.noteOn(40, 100, 0); // row 5: the track has 4 rows, ignored
    rec.noteOff(36, 900);
    rec.onHeard(8160); // the second hit was early: written once heard
    const pat = currentPattern(d);
    expect(pat.steps[0][1]).toBe(90);
    expect(pat.steps[3][2]).toBe(127);
    expect(sent).toEqual([[Op.SET_STEP, d.slot, 0, 1, 90], [Op.SET_STEP, d.slot, 3, 2, 127]]);
    expect(h.labels.undo).toBe(RECORD_LABEL);
    expect(rec.status().canUndoTake).toBe(true);
    rec.undoLastTake(); // both hits in one entry
    expect([pat.steps[0][1], pat.steps[3][2]]).toEqual([0, 0]);
    expect(h.labels.undo).toBe('Step count');
  });
});
