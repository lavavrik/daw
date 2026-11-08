// Live notes while audio is paused (no start splash, spec 2026-11-15 §10).
//
// Before the page's first gesture the AudioContext is suspended: the worklet
// renders nothing, so commands queue in the ring and all play at once on the
// first click. For transport and edit commands that is right (Play pressed
// first still plays), but a MIDI keyboard played meanwhile would burst every
// queued note out together. So the note input's sink drops NOTE_ON while
// the context is not running (the top bar's pill says "Audio paused").
//
// NOTE_OFF always passes: a note started while running and released after
// the browser suspended the context (device change) must still end when it
// resumes, or it would hang. An off for a dropped on is harmless (no voice).
import { Op } from '../audio/protocol';
import type { CommandSink } from '../state/actions';

export function dropNotesWhilePaused(sink: CommandSink, running: () => boolean): CommandSink {
  return {
    send: (op, a, b, c, d) => (op === Op.NOTE_ON && !running() ? false : sink.send(op, a, b, c, d)),
  };
}
