// Web MIDI input. parseMidi is a pure decoder; connectMidi owns the
// browser plumbing and, crucially, stuck-note safety: every input's held
// notes and pedal are tracked so unplugging a keyboard (or disposing)
// always sends the matching NOTE_OFF / SUSTAIN 0 to the engine.
import { Op } from '../audio/protocol';
import type { CommandSink } from '../state/actions';

export type MidiEvent =
  | { t: 'on'; note: number; vel: number }
  | { t: 'off'; note: number }
  | { t: 'bend'; v: number } // -1..1
  | { t: 'mod'; v: number } // 0..1
  | { t: 'sustain'; on: boolean };

export interface MidiStatus {
  state: 'unsupported' | 'denied' | 'no-devices' | 'connected';
  devices: string[];
}

/** Decodes one MIDI message (omni: channel ignored). Running status, sysex and anything else -> null. */
export function parseMidi(data: Uint8Array): MidiEvent | null {
  if (data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const d1 = data[1] & 0x7f;
  const d2 = data[2] & 0x7f;
  switch (kind) {
    case 0x90:
      return d2 === 0 ? { t: 'off', note: d1 } : { t: 'on', note: d1, vel: d2 };
    case 0x80:
      return { t: 'off', note: d1 };
    case 0xe0:
      return { t: 'bend', v: Math.max(-1, Math.min(1, ((d1 | (d2 << 7)) - 8192) / 8192)) };
    case 0xb0:
      if (d1 === 1) return { t: 'mod', v: d2 / 127 };
      if (d1 === 64) return { t: 'sustain', on: d2 >= 64 };
      return null;
    default:
      return null;
  }
}

interface InputLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null;
}
interface AccessLike {
  inputs: Map<string, InputLike>;
  onstatechange: ((e?: unknown) => void) | null;
}

/**
 * Requests MIDI access (Chrome shows a permission prompt) and wires every
 * input to `sink`. Hot-plug aware. Resolves to a disposer that releases
 * anything still held. Never rejects: failures are reported via onStatus.
 */
export async function connectMidi(sink: CommandSink, onStatus: (s: MidiStatus) => void): Promise<() => void> {
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

  // Per input id: notes held and pedal state.
  const held = new Map<string, { notes: Set<number>; pedal: boolean }>();
  const bound = new Map<string, InputLike>();

  const releaseInput = (id: string) => {
    const h = held.get(id);
    if (!h) return;
    for (const n of h.notes) sink.send(Op.NOTE_OFF, n);
    if (h.pedal) sink.send(Op.SUSTAIN, 0);
    held.delete(id);
  };

  const handle = (id: string, data: Uint8Array | null) => {
    const ev = data && parseMidi(data);
    if (!ev) return;
    const h = held.get(id)!;
    switch (ev.t) {
      case 'on':
        h.notes.add(ev.note);
        sink.send(Op.NOTE_ON, ev.note, ev.vel);
        break;
      case 'off':
        h.notes.delete(ev.note);
        sink.send(Op.NOTE_OFF, ev.note);
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
        break;
    }
  };

  const sync = () => {
    const live = new Map<string, InputLike>();
    for (const inp of access.inputs.values()) if (inp.state !== 'disconnected') live.set(inp.id, inp);
    // Gone inputs: release first, then unbind.
    for (const [id, inp] of bound) {
      if (live.get(id) !== inp) {
        releaseInput(id);
        inp.onmidimessage = null;
        bound.delete(id);
      }
    }
    for (const [id, inp] of live) {
      if (bound.has(id)) continue;
      held.set(id, { notes: new Set(), pedal: false });
      inp.onmidimessage = (e) => handle(id, e.data);
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
      releaseInput(id);
      inp.onmidimessage = null;
    }
    bound.clear();
  };
}
