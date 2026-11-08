import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { createNoteInput } from './noteInput';

describe('noteInput', () => {
  it('noteInput forwards to sink and recorder', () => {
    const sent: number[][] = [];
    const sink = { send: (...a: number[]) => (sent.push(a), true) };
    const calls: unknown[][] = [];
    const rec = {
      noteOn: (...a: unknown[]) => void calls.push(['on', ...a]),
      noteOff: (...a: unknown[]) => void calls.push(['off', ...a]),
      closeSource: (...a: unknown[]) => void calls.push(['close', ...a]),
      sustain: (...a: unknown[]) => void calls.push(['sustain', ...a]),
    };
    const input = createNoteInput(sink, rec);
    input.on(60, 100, 12.5, 'qwerty');
    input.off(60, 20, 'qwerty');
    input.closeSource('midi:a');
    input.sustain(true, 30, 'midi:a'); // recorder only: the engine's SUSTAIN is sent by the input itself
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
    expect(calls).toEqual([
      ['on', 60, 100, 12.5, 'qwerty'], ['off', 60, 20, 'qwerty'], ['close', 'midi:a'], ['sustain', true, 30, 'midi:a'],
    ]);
    // Without a recorder it is just the sink.
    const bare = createNoteInput(sink, null);
    bare.on(61, 90, 0, 'x');
    expect(sent.at(-1)).toEqual([Op.NOTE_ON, 61, 90]);
  });

  it('a recorder that throws never blocks the note reaching the engine', () => {
    const sent: number[][] = [];
    const sink = { send: (...a: number[]) => (sent.push(a), true) };
    const boom = () => { throw new Error('x'); };
    const input = createNoteInput(sink, { noteOn: boom, noteOff: boom, closeSource: boom, sustain: boom });
    expect(() => input.on(60, 100, 0, 'q')).not.toThrow();
    expect(() => input.off(60, 0, 'q')).not.toThrow();
    expect(sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.NOTE_OFF, 60]]);
  });

  it('a note-on wakes the visuals, after the engine got it', () => {
    const order: string[] = [];
    const sink = { send: (op: number) => (order.push(op === Op.NOTE_ON ? 'on' : 'off'), true) };
    const input = createNoteInput(sink, null, () => {
      order.push('wake');
      throw new Error('a visual must never stop a note');
    });
    expect(() => input.on(60, 100, 0, 'q')).not.toThrow();
    input.off(60, 0, 'q'); // no wake: a note-off brings nothing new to show
    expect(order).toEqual(['on', 'wake', 'off']);
  });

  it('onNoteOn gets the note (App keeps the last live note: input/lastNote.svelte.ts)', () => {
    const got: number[] = [];
    const input = createNoteInput({ send: () => true }, null, (n) => got.push(n));
    input.on(64, 100, 0, 'midi:x');
    input.off(64, 0, 'midi:x');
    expect(got).toEqual([64]);
  });
});
