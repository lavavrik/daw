import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { createNoteInput } from './noteInput';
import { dropNotesWhilePaused } from './pausedGate';

function setup() {
  const sent: number[][] = [];
  let running = false;
  const sink = { send: (op: number, a = 0, b = 0) => (sent.push([op, a, b]), true) };
  const input = createNoteInput(dropNotesWhilePaused(sink, () => running), null);
  return { sent, input, run: () => (running = true) };
}

describe('dropNotesWhilePaused', () => {
  it('drops note-ons played while paused: nothing queues to burst out on the first click', () => {
    const { sent, input } = setup();
    input.on(60, 100, 0, 'midi:a');
    input.on(64, 100, 0, 'midi:a');
    expect(sent.filter(([op]) => op === Op.NOTE_ON)).toEqual([]);
  });
  it('lets note-offs through (a note held across a later suspension still ends)', () => {
    const { sent, input } = setup();
    input.off(60, 0, 'midi:a');
    expect(sent).toEqual([[Op.NOTE_OFF, 60, 0]]);
  });
  it('passes everything once audio runs', () => {
    const { sent, input, run } = setup();
    run();
    input.on(60, 100, 0, 'qwerty');
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100]]);
  });
  it('never touches other commands (bend, transport)', () => {
    const sent: number[] = [];
    const gate = dropNotesWhilePaused({ send: (op) => (sent.push(op), true) }, () => false);
    gate.send(Op.PITCH_BEND, 0);
    gate.send(Op.PLAY);
    expect(sent).toEqual([Op.PITCH_BEND, Op.PLAY]);
  });
});
