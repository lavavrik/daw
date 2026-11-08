// Note input bus: the single path every *played* note takes (QWERTY piano,
// MIDI keyboards, later the piano-roll keyboard). It sends NOTE_ON/NOTE_OFF to
// the engine exactly as the inputs used to, then tells the recorder.
//
// Engine first, recorder second, and a recorder error is swallowed (logged):
// recording must never be able to stop a note from sounding or, worse, from
// being released (stuck notes are the #1 live-input risk).
//
// Bend, mod wheel, sustain and panic still go straight to the sink. The
// sustain pedal is additionally reported here (sustain(): recorder only, no
// engine command) so recorded notes honour it. A panic (or an unplugged
// keyboard) calls closeSource(source) so the recorder ends that input's notes.
//
// `onNoteOn` (plan 12; App passes visWake().wake): after the engine got a
// note-on, idle visuals (voice LEDs, analysers: ui/vis/visWake.ts) come back
// to show it, also while the transport is stopped. Its errors are swallowed
// like the recorder's. It gets the note: App also keeps it as the last live
// note (input/lastNote.svelte.ts, the Sample Player's "Root ← last note").
import { Op } from '../audio/protocol';
import type { CommandSink } from '../state/actions';

/** What the bus needs from the recorder (state/recorder.ts implements it). */
export interface NoteListener {
  noteOn(pitch: number, vel: number, perfMs: number, source: string): void;
  noteOff(pitch: number, perfMs: number, source: string): void;
  /** The input went away / panicked: close its open notes now (and forget its pedal). */
  closeSource(source: string): void;
  /** Sustain pedal down/up on `source`. */
  sustain(on: boolean, perfMs: number, source: string): void;
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
  /** Tells the recorder only; the input sends Op.SUSTAIN to the engine itself. */
  sustain(on: boolean, perfMs: number, source: string): void;
}

export function createNoteInput(sink: CommandSink, recorder: NoteListener | null, onNoteOn?: (note: number) => void): NoteInput {
  const tell = (f: () => void) => {
    try {
      f();
    } catch (err) {
      console.error('note listener failed', err);
    }
  };
  return {
    on(note, vel, perfMs, source) {
      sink.send(Op.NOTE_ON, note, vel);
      if (onNoteOn) tell(() => onNoteOn(note));
      if (recorder) tell(() => recorder.noteOn(note, vel, perfMs, source));
    },
    off(note, perfMs, source) {
      sink.send(Op.NOTE_OFF, note);
      if (recorder) tell(() => recorder.noteOff(note, perfMs, source));
    },
    closeSource(source) {
      if (recorder) tell(() => recorder.closeSource(source));
    },
    sustain(on, perfMs, source) {
      if (recorder) tell(() => recorder.sustain(on, perfMs, source));
    },
  };
}
