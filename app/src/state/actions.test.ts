import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { Project } from './project.svelte';
import { addDrumTrack, addRow, setRowSample, setTempo, toggleStep } from './actions';

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
    expect(t2.rows[0].steps).toHaveLength(64);
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
});
