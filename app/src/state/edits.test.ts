import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { Project } from './project.svelte';
import { addDrumTrack, addRow } from './actions';
import { renamePattern } from './pattern-actions';
import { commandEdits, edit, markEdited } from './edits';

describe('edit tracking (fix 5)', () => {
  it('edit commands mark the project dirty and bump its version; transport and live notes do not', () => {
    const p = new Project();
    for (const op of [Op.NOTE_ON, Op.NOTE_OFF, Op.PLAY, Op.STOP, Op.SEEK, Op.SET_INPUT_TRACK, Op.PITCH_BEND, Op.MOD_WHEEL, Op.SUSTAIN, Op.RESET_ALL, Op.AUTO_OVERRIDE]) {
      commandEdits(p, op);
    }
    expect([p.dirty, p.version]).toEqual([false, 0]);
    for (const op of [Op.SET_STEP, Op.RACK_SET_PARAM, Op.MIX_SET, Op.SET_TEMPO, Op.SET_MODE, Op.CLIP_SET, Op.AUTO_POINT_SET]) commandEdits(p, op);
    expect([p.dirty, p.version]).toEqual([true, 7]);
  });

  it('VIS_TAP is not an edit', () => {
    // The strip tap only picks what the analyser shows (plan 12).
    const p = new Project();
    commandEdits(p, Op.VIS_TAP);
    expect([p.dirty, p.version]).toEqual([false, 0]);
  });

  it('SET_PATTERN_FOCUS is not an edit', () => {
    // Which track the pattern transport plays is transport state (plan 20 task 12).
    const p = new Project();
    commandEdits(p, Op.SET_PATTERN_FOCUS);
    expect([p.dirty, p.version]).toEqual([false, 0]);
  });

  it('nothing is marked while a load replaces the session', () => {
    const p = new Project();
    p.loading = true;
    commandEdits(p, Op.SET_STEP);
    markEdited(p);
    expect([p.dirty, p.version]).toEqual([false, 0]);
  });

  it('edits that send no command mark it themselves (add row, rename pattern)', () => {
    const p = new Project();
    const t = addDrumTrack(p, { send: () => true })!;
    const v = p.version;
    addRow(p, { send: () => true }, t.id);
    renamePattern(p, { send: () => true }, t.id, t.patterns[0].id, 'Verse');
    expect(p.version).toBe(v + 2);
    expect(p.dirty).toBe(true);
  });
  it('a starting-point change (baselining) marks nothing and is no undo entry (plan 8 Task 4)', () => {
    const p = new Project();
    let transacts = 0;
    p.history = { transact: (_l: string, fn: () => unknown) => (transacts++, fn()) } as unknown as Project['history'];
    p.baselining = true;
    commandEdits(p, Op.SET_ROW_SAMPLE);
    markEdited(p);
    expect(edit(p, 'Load sample', () => 7)).toBe(7);
    expect([p.dirty, p.version, transacts]).toEqual([false, 0, 0]);
    p.baselining = false;
    edit(p, 'Load sample', () => commandEdits(p, Op.SET_ROW_SAMPLE));
    expect([p.dirty, p.version, transacts]).toEqual([true, 1, 1]);
  });
});
