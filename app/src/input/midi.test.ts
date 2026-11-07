import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { connectMidi, parseMidi } from './midi';
import type { MidiStatus } from './midi';

const u = (...b: number[]) => new Uint8Array(b);

describe('parseMidi', () => {
  it('note on / off', () => {
    expect(parseMidi(u(0x90, 60, 100))).toEqual({ t: 'on', note: 60, vel: 100 });
    expect(parseMidi(u(0x80, 60, 0))).toEqual({ t: 'off', note: 60 });
  });
  it('velocity-0 note-on is note-off', () => expect(parseMidi(u(0x90, 60, 0))).toEqual({ t: 'off', note: 60 }));
  it('pitch bend min / centre / max', () => {
    expect(parseMidi(u(0xe0, 0, 0))).toEqual({ t: 'bend', v: -1 });
    expect(parseMidi(u(0xe0, 0, 64))).toEqual({ t: 'bend', v: 0 });
    expect(parseMidi(u(0xe0, 127, 127))).toEqual({ t: 'bend', v: 8191 / 8192 });
  });
  it('mod wheel CC1', () => expect(parseMidi(u(0xb0, 1, 127))).toEqual({ t: 'mod', v: 1 }));
  it('sustain CC64', () => {
    expect(parseMidi(u(0xb0, 64, 127))).toEqual({ t: 'sustain', on: true });
    expect(parseMidi(u(0xb0, 64, 0))).toEqual({ t: 'sustain', on: false });
  });
  it('other CCs, sysex, running status, short data -> null', () => {
    expect(parseMidi(u(0xb0, 7, 100))).toBeNull();
    expect(parseMidi(u(0xf0, 0x7e, 0xf7))).toBeNull();
    expect(parseMidi(u(60, 100))).toBeNull();
    expect(parseMidi(u(0x90, 60))).toBeNull();
  });
  it('CC120 All Sound Off / CC123 All Notes Off -> panic (any value)', () => {
    expect(parseMidi(u(0xb0, 120, 0))).toEqual({ t: 'panic' });
    expect(parseMidi(u(0xbf, 123, 0))).toEqual({ t: 'panic' });
  });
  it('accepts channel 10 (omni)', () => expect(parseMidi(u(0x99, 36, 90))).toEqual({ t: 'on', note: 36, vel: 90 }));
});

type Fake = { id: string; name: string; state: string; onmidimessage: ((e: { data: Uint8Array }) => void) | null };
function fakeAccess(inputs: Fake[]) {
  const map = new Map(inputs.map((i) => [i.id, i]));
  const acc = { inputs: map, onstatechange: null as null | (() => void) };
  return acc;
}
const mkInput = (id: string, name = id): Fake => ({ id, name, state: 'connected', onmidimessage: null });
const mkSink = () => {
  const sent: number[][] = [];
  return { sent, send: (...a: number[]) => (sent.push(a), true) };
};
const setNav = (v: unknown) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
function install(access: unknown) {
  setNav({ requestMIDIAccess: async () => access });
}

describe('connectMidi', () => {
  it('unsupported when the API is missing', async () => {
    setNav({});
    const s: MidiStatus[] = [];
    await connectMidi(mkSink(), (x) => s.push(x));
    expect(s.at(-1)).toEqual({ state: 'unsupported', devices: [] });
  });
  it('denied when the request rejects', async () => {
    setNav({ requestMIDIAccess: async () => { throw new Error('no'); } });
    const s: MidiStatus[] = [];
    await connectMidi(mkSink(), (x) => s.push(x));
    expect(s.at(-1)).toEqual({ state: 'denied', devices: [] });
  });
  it('reports devices and routes events to the sink', async () => {
    const a = mkInput('a', 'Keystation');
    const acc = fakeAccess([a]);
    install(acc);
    const sink = mkSink();
    const s: MidiStatus[] = [];
    await connectMidi(sink, (x) => s.push(x));
    expect(s.at(-1)).toEqual({ state: 'connected', devices: ['Keystation'] });
    a.onmidimessage!({ data: u(0x90, 60, 100) });
    a.onmidimessage!({ data: u(0xb0, 64, 127) });
    expect(sink.sent).toEqual([[Op.NOTE_ON, 60, 100], [Op.SUSTAIN, 1]]);
  });
  it('no-devices when there are no inputs', async () => {
    install(fakeAccess([]));
    const s: MidiStatus[] = [];
    await connectMidi(mkSink(), (x) => s.push(x));
    expect(s.at(-1)).toEqual({ state: 'no-devices', devices: [] });
  });
  it('a panic CC releases that input\'s held notes and the pedal', async () => {
    const a = mkInput('a');
    const b = mkInput('b');
    install(fakeAccess([a, b]));
    const sink = mkSink();
    await connectMidi(sink, () => {});
    a.onmidimessage!({ data: u(0x90, 60, 100) });
    a.onmidimessage!({ data: u(0x90, 64, 100) });
    a.onmidimessage!({ data: u(0xb0, 64, 127) });
    b.onmidimessage!({ data: u(0x90, 72, 100) });
    sink.sent.length = 0;
    a.onmidimessage!({ data: u(0xb0, 123, 0) });
    expect(sink.sent).toEqual([[Op.NOTE_OFF, 60], [Op.NOTE_OFF, 64], [Op.SUSTAIN, 0]]);
    // Nothing left to release for `a` afterwards; `b`'s note is untouched.
    sink.sent.length = 0;
    a.onmidimessage!({ data: u(0xb0, 120, 0) });
    expect(sink.sent).toEqual([[Op.SUSTAIN, 0]]);
  });
  it('unplugging a device releases its held notes and pedal', async () => {
    const a = mkInput('a');
    const b = mkInput('b');
    const acc = fakeAccess([a, b]);
    install(acc);
    const sink = mkSink();
    await connectMidi(sink, () => {});
    a.onmidimessage!({ data: u(0x90, 60, 100) });
    a.onmidimessage!({ data: u(0x90, 64, 100) });
    a.onmidimessage!({ data: u(0xb0, 64, 127) });
    b.onmidimessage!({ data: u(0x90, 72, 100) });
    sink.sent.length = 0;
    a.state = 'disconnected';
    acc.onstatechange!();
    expect(sink.sent).toEqual([[Op.NOTE_OFF, 60], [Op.NOTE_OFF, 64], [Op.SUSTAIN, 0]]);
    expect(a.onmidimessage).toBeNull();
  });
  it('hot-plugged inputs are bound; disposer releases everything', async () => {
    const acc = fakeAccess([]);
    install(acc);
    const sink = mkSink();
    const s: MidiStatus[] = [];
    const dispose = await connectMidi(sink, (x) => s.push(x));
    const c = mkInput('c', 'New');
    acc.inputs.set('c', c);
    acc.onstatechange!();
    expect(s.at(-1)).toEqual({ state: 'connected', devices: ['New'] });
    c.onmidimessage!({ data: u(0x90, 50, 80) });
    sink.sent.length = 0;
    dispose();
    expect(sink.sent).toEqual([[Op.NOTE_OFF, 50]]);
    expect(c.onmidimessage).toBeNull();
  });
});
