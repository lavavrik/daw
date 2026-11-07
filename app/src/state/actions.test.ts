import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { Project, currentPattern } from './project.svelte';
import type { DrumPattern } from './project.svelte';
import {
  addDrumTrack, addRow, play, setRowSample, setStep, setStepCount, setSwing, setTempo, stop, togglePlay, toggleStep,
} from './actions';
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
    expect(sent.map((s) => s.slice(0, 2))).toEqual([
      [Op.ADD_DRUM_TRACK, 0],
      [Op.ADD_DRUM_TRACK, 1],
      [Op.ADD_DRUM_TRACK, 0],
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
});
