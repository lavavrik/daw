import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import type { DrumPattern } from './project.svelte';
import {
  addDrumTrack, addRow, liveInputTrack, moveTrack, play, previewTempo, removeTrack, selectTrack, setRowSample, setStep, setStepCount, setSwing,
  setTempo, stop, togglePlay, toggleStep,
} from './actions';
import { createHistory } from '../history/history';
import { diffApply } from '../history/diffApply';
import { serialize } from '../project/serialize';
import { addSynthTrack } from './rack-actions';
import { newPattern, selectPattern } from './pattern-actions';

function fake() {
  const sent: number[][] = [];
  return {
    sent,
    sink: {
      send(op: number, a = 0, b = 0, c = 0, d = 0) {
        sent.push([op, a, b, c, d]);
        return true;
      },
    },
  };
}

describe('actions', () => {
  it('addDrumTrack sends ADD_DRUM_TRACK with lowest free slot', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t0 = addDrumTrack(p, sink)!;
    const t1 = addDrumTrack(p, sink)!;
    expect([t0.slot, t1.slot]).toEqual([0, 1]);
    p.tracks.splice(0, 1); // free slot 0
    const t2 = addDrumTrack(p, sink)!;
    expect(t2.slot).toBe(0);
    // Each add also selects the new drum track, which becomes the live input.
    expect(sent.map((s) => s.slice(0, 2))).toEqual([
      [Op.ADD_DRUM_TRACK, 0],
      [Op.SET_INPUT_TRACK, 0],
      [Op.ADD_DRUM_TRACK, 1],
      [Op.SET_INPUT_TRACK, 1],
      [Op.ADD_DRUM_TRACK, 0],
      [Op.SET_INPUT_TRACK, 0],
    ]);
    expect(t2.rows.map((r) => r.name)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4']);
    expect(t2.patterns).toHaveLength(1);
    const pat = t2.patterns[0];
    expect([pat.id, pat.engineIdx, pat.name, pat.stepCount, pat.swing]).toEqual([t2.currentPatternId, 0, 'Pattern 1', 16, 0]);
    expect(pat.steps).toHaveLength(16); // MAX_ROWS rows, each MAX_STEPS
    expect(pat.steps.every((r) => r.length === 64 && r.every((v) => v === 0))).toBe(true);
    expect(t2.clips).toEqual([]);
    expect(p.selectedTrackId).toBe(t2.id);
  });

  it('toggleStep sends SET_STEP 100 then 0', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    toggleStep(p, sink, t.id, t.rows[1].id, 3);
    toggleStep(p, sink, t.id, t.rows[1].id, 3);
    expect(sent).toEqual([
      [Op.SET_STEP, 0, 1, 3, 100],
      [Op.SET_STEP, 0, 1, 3, 0],
    ]);
  });

  it('step edits go to the current pattern after selectPattern', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    const [p0] = t.patterns;
    toggleStep(p, sink, t.id, t.rows[0].id, 0);
    const p1 = newPattern(p, sink, t.id) as DrumPattern;
    sent.length = 0;
    toggleStep(p, sink, t.id, t.rows[1].id, 2);
    setStepCount(p, sink, t.id, 32);
    setSwing(p, sink, t.id, 0.25);
    expect(currentPattern(t)).toBe(p1);
    expect([p1.steps[1][2], p1.steps[0][0], p1.stepCount, p1.swing]).toEqual([100, 0, 32, 0.25]);
    expect([p0.steps[1][2], p0.steps[0][0], p0.stepCount, p0.swing]).toEqual([0, 100, 16, 0]);
    // The edits never switch the engine's pattern (only selectPattern does).
    expect(sent).toEqual([
      [Op.SET_STEP, 0, 1, 2, 100],
      [Op.SET_STEP_COUNT, 0, 32, 0, 0],
      [Op.SET_SWING, 0, 0.25, 0, 0],
    ]);
    sent.length = 0;
    selectPattern(p, sink, t.id, p0.id);
    setStep(p, sink, t.id, t.rows[0].id, 0, 0);
    expect(sent).toEqual([[Op.SET_CURRENT_PATTERN, 0, 0, 0, 0], [Op.SET_STEP, 0, 0, 0, 0]]);
    expect(p0.steps[0][0]).toBe(0);
    // A new row is already present (empty) in every pattern.
    const r = addRow(p, sink, t.id)!;
    toggleStep(p, sink, t.id, r.id, 5);
    expect(p0.steps[4][5]).toBe(100);
    expect(p1.steps[4][5]).toBe(0);
  });

  it('setTempo clamps and ignores NaN', () => {
    const p = new Project();
    const { sink, sent } = fake();
    setTempo(p, sink, 500);
    expect(sent).toEqual([[Op.SET_TEMPO, 300, 0, 0, 0]]);
    expect(p.tempo).toBe(300);
    setTempo(p, sink, NaN);
    expect(sent).toHaveLength(1);
  });

  it('previewTempo (a tempo scrub) is heard but is no edit: p.tempo and the history stay', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t0 = p.tempo;
    previewTempo(sink, 133.33);
    previewTempo(sink, 900);
    previewTempo(sink, NaN);
    expect(sent).toEqual([[Op.SET_TEMPO, 133.3, 0, 0, 0], [Op.SET_TEMPO, 300, 0, 0, 0]]);
    expect(p.tempo).toBe(t0);
  });

  it('addRow stops at 16', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    for (let i = 0; i < 12; i++) expect(addRow(p, sink, t.id)).not.toBeNull();
    expect(t.rows).toHaveLength(16);
    expect(addRow(p, sink, t.id)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('setRowSample sends sample id and renames row', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const t = addDrumTrack(p, sink)!;
    sent.length = 0;
    setRowSample(p, sink, t.id, t.rows[2].id, 5, 'kick.wav');
    expect(sent).toEqual([[Op.SET_ROW_SAMPLE, 0, 2, 5, 0]]);
    expect(t.rows[2].sampleId).toBe(5);
    expect(t.rows[2].name).toBe('kick.wav');
  });

  it('play takes a count-in: 0 or one bar (anything else plays without)', () => {
    const p = new Project();
    const { sink, sent } = fake();
    play(p, sink, 3840);
    stop(p, sink);
    play(p, sink, 1234);
    stop(p, sink);
    togglePlay(p, sink, 3840);
    togglePlay(p, sink);
    play(p, sink);
    expect(sent.map((s) => s.slice(0, 2))).toEqual([
      [Op.PLAY, 3840], [Op.STOP, 0], [Op.PLAY, 0], [Op.STOP, 0], [Op.PLAY, 3840], [Op.STOP, 0], [Op.PLAY, 0],
    ]);
  });

  it('play on a failed or closed engine (send refused) leaves the transport stopped', () => {
    const p = new Project();
    const dead = { send: () => false };
    expect(play(p, dead)).toBe(false);
    expect(p.playing).toBe(false);
    togglePlay(p, dead);
    expect(p.playing).toBe(false);
    expect(play(p, fake().sink)).toBe(true);
    expect(p.playing).toBe(true);
  });
});

describe('live input track (plan 15: drum rows from the MIDI keyboard)', () => {
  it('liveInputTrack picks a selected drum track; selecting it sends SET_INPUT_TRACK', () => {
    const p = new Project();
    const { sink, sent } = fake();
    const s = addSynthTrack(p, sink)!;
    const d = addDrumTrack(p, sink)!; // adding selects it: keys go to its rows
    expect(liveInputTrack(p)?.id).toBe(d.id);
    expect(sent[sent.length - 1]).toEqual([Op.SET_INPUT_TRACK, d.slot, 0, 0, 0]);
    sent.length = 0;
    selectTrack(p, sink, s.id);
    expect(sent).toEqual([[Op.SET_INPUT_TRACK, s.slot, 0, 0, 0]]);
    sent.length = 0;
    selectTrack(p, sink, d.id);
    expect(sent).toEqual([[Op.SET_INPUT_TRACK, d.slot, 0, 0, 0]]);
    expect(p.lastSynthTrackId).toBe(s.id); // a drum never becomes the last synth
    // Removing the drum input: selection falls back, keys follow it.
    sent.length = 0;
    removeTrack(p, sink, d.id);
    expect(sent).toEqual([[Op.REMOVE_TRACK, d.slot, 0, 0, 0], [Op.SET_INPUT_TRACK, s.slot, 0, 0, 0]]);
  });

  it('an audio track selected keeps the last synth as the input', () => {
    const p = new Project();
    const { sink } = fake();
    const s = addSynthTrack(p, sink)!;
    p.tracks.push({ kind: 'audio', id: 'a', slot: 5, name: 'Vox', color: '#fff', clips: [], automation: [] } as never);
    p.selectedTrackId = 'a';
    expect(liveInputTrack(p)?.id).toBe(s.id);
  });
});

describe('moveTrack (plan 22 Task 4: reorder the song tracks)', () => {
  /** Three tracks (drum, synth, drum) with an undo history whose undo/redo run diffApply. */
  function rig() {
    const p = new Project();
    const { sink, sent } = fake();
    p.history = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to) });
    const a = addDrumTrack(p, sink, 'A')!;
    const b = addSynthTrack(p, sink, 'B')!;
    const c = addDrumTrack(p, sink, 'C')!;
    sent.length = 0;
    const order = () => p.tracks.map((t) => t.name);
    return { p, sink, sent, a, b, c, order };
  }

  it('permutes p.tracks only: no engine command, slots / ids / colours kept, marked edited', () => {
    const { p, sent, a, b, c, order } = rig();
    const before = p.tracks.map((t) => [t.id, t.slot, t.color]);
    const v = p.version;
    p.dirty = false;
    expect(moveTrack(p, 2, 0)).toBe(true);
    expect(order()).toEqual(['C', 'A', 'B']);
    expect(sent).toEqual([]);
    expect(p.dirty).toBe(true);
    expect(p.version).toBeGreaterThan(v);
    expect(new Set(p.tracks.map((t) => [t.id, t.slot, t.color].join()))).toEqual(new Set(before.map((x) => x.join())));
    expect(p.tracks.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    expect(moveTrack(p, 0, 2)).toBe(true); // down to the end
    expect(order()).toEqual(['A', 'B', 'C']);
  });

  it('refuses a move to the same place or out of range: no write, not dirty', () => {
    const { p, order } = rig();
    p.dirty = false;
    const v = p.version;
    for (const [from, to] of [[1, 1], [-1, 0], [0, 3], [3, 0], [0.5, 1], [NaN, 0]]) expect(moveTrack(p, from, to)).toBe(false);
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(p.dirty).toBe(false);
    expect(p.version).toBe(v);
    expect(p.history!.labels.undo).not.toBe('Move track');
  });

  it('is one undo entry; undo / redo restore the order without any engine command', () => {
    const { p, sent, order } = rig();
    moveTrack(p, 2, 0);
    expect(p.history!.labels.undo).toBe('Move track');
    expect(p.history!.undo()).toBe(true);
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(p.history!.redo()).toBe(true);
    expect(order()).toEqual(['C', 'A', 'B']);
    expect(sent).toEqual([]); // no slot changed: the engine never hears of it
  });

  it('keeps the selection and the live input (both by id / slot)', () => {
    const { p, sink, sent, b } = rig();
    selectTrack(p, sink, b.id);
    sent.length = 0;
    moveTrack(p, 1, 2);
    expect(p.selectedTrackId).toBe(b.id);
    expect(liveInputTrack(p)?.id).toBe(b.id);
    expect(sent).toEqual([]);
  });
});
