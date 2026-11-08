// Web MIDI input. parseMidi is a pure decoder; connectMidi owns the
// browser plumbing and, crucially, stuck-note safety: every input's held
// notes and pedal are tracked so unplugging a keyboard (or disposing)
// always sends the matching NOTE_OFF / SUSTAIN 0 to the engine.
//
// Notes go through the note input bus (noteInput.ts) stamped with the
// MIDIMessageEvent's timeStamp (performance time) and source `midi:<input id>`;
// bend / mod / sustain / panic go straight to the sink. A panic or an unplug
// also tells the recorder to close that input's open notes.
import { Op } from '../audio/protocol';
import type { CommandSink } from '../state/actions';
import type { NoteInput } from './noteInput';

export type MidiEvent =
  | { t: 'on'; note: number; vel: number }
  | { t: 'off'; note: number }
  | { t: 'bend'; v: number } // -1..1
  | { t: 'mod'; v: number } // 0..1
  | { t: 'sustain'; on: boolean }
  /** CC120 All Sound Off / CC123 All Notes Off (keyboards' panic button). */
  | { t: 'panic' }
  /** Any learnable CC (0..119, incl. 1 and 64), value 0..127. */
  | { t: 'cc'; cc: number; v: number };

export interface MidiStatus {
  state: 'unsupported' | 'denied' | 'no-devices' | 'connected';
  devices: string[];
}

/**
 * Decodes one MIDI message (omni: channel ignored) into zero or more events.
 * CC1 / CC64 yield their dedicated event AND a `cc` (both are learnable);
 * CC120/123 are panic only; other CCs 0..119 are `cc`. Running status,
 * sysex and anything else -> [].
 */
export function parseMidi(data: Uint8Array): MidiEvent[] {
  if (data.length < 3) return [];
  const kind = data[0] & 0xf0;
  const d1 = data[1] & 0x7f;
  const d2 = data[2] & 0x7f;
  switch (kind) {
    case 0x90:
      return [d2 === 0 ? { t: 'off', note: d1 } : { t: 'on', note: d1, vel: d2 }];
    case 0x80:
      return [{ t: 'off', note: d1 }];
    case 0xe0:
      return [{ t: 'bend', v: Math.max(-1, Math.min(1, ((d1 | (d2 << 7)) - 8192) / 8192)) }];
    case 0xb0:
      if (d1 === 120 || d1 === 123) return [{ t: 'panic' }];
      if (d1 === 1) return [{ t: 'mod', v: d2 / 127 }, { t: 'cc', cc: 1, v: d2 }];
      if (d1 === 64) return [{ t: 'sustain', on: d2 >= 64 }, { t: 'cc', cc: 64, v: d2 }];
      return [{ t: 'cc', cc: d1, v: d2 }];
    default:
      return [];
  }
}

interface InputLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data: Uint8Array | null; timeStamp?: number }) => void) | null;
}
interface AccessLike {
  inputs: Map<string, InputLike>;
  onstatechange: ((e?: unknown) => void) | null;
}

export interface MidiHandler {
  handle(sourceId: string, data: Uint8Array, timeStamp: number): void;
  release(sourceId: string): void;
}

/**
 * Per-message logic with per-source held-note / pedal state, shared by the
 * real inputs (connectMidi) and the test injection hook (__daw.midi.inject).
 * `sourceId` is the input id; the note bus source is `midi:<id>`.
 */
export function createMidiHandler(
  sink: CommandSink, input: NoteInput, onCc?: (cc: number, v: number) => void,
): MidiHandler {
  // Per source id: notes held and pedal state.
  const held = new Map<string, { notes: Set<number>; pedal: boolean }>();
  const source = (id: string) => `midi:${id}`;

  const release = (id: string) => {
    const h = held.get(id);
    if (!h) return;
    for (const n of h.notes) sink.send(Op.NOTE_OFF, n);
    if (h.pedal) sink.send(Op.SUSTAIN, 0);
    held.delete(id);
    input.closeSource(source(id));
  };

  const handle = (id: string, data: Uint8Array, timeStamp: number) => {
    const at = Number.isFinite(timeStamp) ? timeStamp : performance.now();
    for (const ev of parseMidi(data)) {
      let h = held.get(id);
      if (!h) held.set(id, (h = { notes: new Set(), pedal: false }));
      switch (ev.t) {
        case 'on':
          h.notes.add(ev.note);
          input.on(ev.note, ev.vel, at, source(id));
          break;
        case 'off':
          h.notes.delete(ev.note);
          input.off(ev.note, at, source(id));
          break;
        case 'bend':
          sink.send(Op.PITCH_BEND, ev.v);
          break;
        case 'mod':
          sink.send(Op.MOD_WHEEL, ev.v);
          break;
        case 'sustain':
          h.pedal = ev.on;
          sink.send(Op.SUSTAIN, ev.on ? 1 : 0);
          input.sustain(ev.on, at, source(id));
          break;
        case 'cc':
          onCc?.(ev.cc, ev.v);
          break;
        case 'panic':
          // Release this input's held notes and lift the pedal (always: a
          // panic must not depend on our bookkeeping being right). Other
          // inputs' and the QWERTY piano's notes are left alone.
          for (const n of h.notes) sink.send(Op.NOTE_OFF, n);
          h.notes.clear();
          h.pedal = false;
          sink.send(Op.SUSTAIN, 0);
          input.closeSource(source(id));
          break;
      }
    }
  };

  return { handle, release };
}

/**
 * Requests MIDI access (Chrome shows a permission prompt) and wires every
 * input to `sink`. Hot-plug aware. Resolves to a disposer that releases
 * anything still held. Never rejects: failures are reported via onStatus.
 */
export async function connectMidi(
  sink: CommandSink, input: NoteInput, onStatus: (s: MidiStatus) => void,
  onCc?: (cc: number, v: number) => void,
): Promise<() => void> {
  const nav = globalThis.navigator as Navigator & { requestMIDIAccess?: () => Promise<unknown> };
  if (typeof nav?.requestMIDIAccess !== 'function') {
    onStatus({ state: 'unsupported', devices: [] });
    return () => {};
  }
  let access: AccessLike;
  try {
    access = (await nav.requestMIDIAccess()) as unknown as AccessLike;
  } catch {
    onStatus({ state: 'denied', devices: [] });
    return () => {};
  }

  const handler = createMidiHandler(sink, input, onCc);
  const bound = new Map<string, InputLike>();

  const sync = () => {
    const live = new Map<string, InputLike>();
    for (const inp of access.inputs.values()) if (inp.state !== 'disconnected') live.set(inp.id, inp);
    // Gone inputs: release first, then unbind.
    for (const [id, inp] of bound) {
      if (live.get(id) !== inp) {
        handler.release(id);
        inp.onmidimessage = null;
        bound.delete(id);
      }
    }
    for (const [id, inp] of live) {
      if (bound.has(id)) continue;
      inp.onmidimessage = (e) => {
        if (e.data) handler.handle(id, e.data, e.timeStamp as number);
      };
      bound.set(id, inp);
    }
    const devices = [...live.values()].map((i) => i.name || i.id);
    onStatus({ state: devices.length ? 'connected' : 'no-devices', devices });
  };

  access.onstatechange = sync;
  sync();

  return () => {
    access.onstatechange = null;
    for (const [id, inp] of bound) {
      handler.release(id);
      inp.onmidimessage = null;
    }
    bound.clear();
  };
}
