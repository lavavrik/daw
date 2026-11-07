// Note input bus: the single path every *played* note takes (QWERTY piano,
// MIDI keyboards, later the piano-roll keyboard). It sends NOTE_ON/NOTE_OFF to
// the engine exactly as the inputs used to, then tells the recorder.
//
// Engine first, recorder second, and a recorder error is swallowed (logged):
// recording must never be able to stop a note from sounding or, worse, from
// being released (stuck notes are the #1 live-input risk).
//
// Bend, mod wheel, sustain and panic do NOT go through here; they still go
// straight to the sink. A panic (or an unplugged keyboard) calls
// closeSource(source) so the recorder ends that input's open notes.
import { Op } from '../audio/protocol';
import type { CommandSink } from '../state/actions';

/** What the bus needs from the recorder (state/recorder.ts implements it). */
export interface NoteListener {
  noteOn(pitch: number, vel: number, perfMs: number, source: string): void;
  noteOff(pitch: number, perfMs: number, source: string): void;
  /** The input went away / panicked: close its open notes now. */
  closeSource(source: string): void;
}

export interface NoteInput {
  /**
   * `perfMs` is the event's performance-time stamp (KeyboardEvent.timeStamp,
   * MIDIMessageEvent.timeStamp); `source` identifies the input ('qwerty',
   * 'midi:<id>', …) so the same pitch held on two inputs stays two notes.
   */
  on(note: number, vel: number, perfMs: number, source: string): void;
  off(note: number, perfMs: number, source: string): void;
  closeSource(source: string): void;
}

export function createNoteInput(sink: CommandSink, recorder: NoteListener | null): NoteInput {
  const tell = (f: () => void) => {
    try {
      f();
    } catch (err) {
      console.error('recorder failed', err);
    }
  };
  return {
    on(note, vel, perfMs, source) {
      sink.send(Op.NOTE_ON, note, vel);
      if (recorder) tell(() => recorder.noteOn(note, vel, perfMs, source));
    },
    off(note, perfMs, source) {
      sink.send(Op.NOTE_OFF, note);
      if (recorder) tell(() => recorder.noteOff(note, perfMs, source));
    },
    closeSource(source) {
      if (recorder) tell(() => recorder.closeSource(source));
    },
  };
}
