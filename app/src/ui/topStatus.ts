// The top bar's right end (plan 22 Task 1): empty in the normal state, ONE
// compact warning badge when something needs attention. TopBar.svelte draws
// it; this file decides what it says (pure, unit-tested in topStatus.test.ts).
//
// Order, first match wins:
//   1. audio paused / failed: the existing pill (AudioStatusPill.svelte,
//      audio/audioStatus.ts), decided by TopBar before calling topWarning;
//   2. dropouts in the last 10 s (createDropWindow) → opens Audio settings;
//   3. MIDI blocked by the browser → opens the MIDI popover (it says how to
//      unblock);
//   4. output latency over BT_LATENCY_MS (Bluetooth-size) → Audio settings.
// "No MIDI device" and "no Web MIDI" are normal states, not warnings: Options
// ▸ MIDI… says them in its label (midiLabel).
import { BT_LATENCY_MS } from '../audio/restart';
import type { MidiStatus } from '../input/midi';

/** How far back a dropout still raises the badge. */
export const DROP_WINDOW_MS = 10_000;

/**
 * Dropouts in the last `windowMs`, from the engine's running total sampled
 * over time (TopBar: 4 Hz). `push(now, total)` returns the count. The first
 * sample counts from 0 (dropouts during start-up are recent); a total lower
 * than the last one is a new engine (an audio restart) and starts over.
 */
export function createDropWindow(windowMs = DROP_WINDOW_MS) {
  // samples[0] is the baseline: the newest sample at or before now − window
  // (or the start, total 0). Everything after it is inside the window.
  let samples: { t: number; total: number }[] = [];
  return {
    push(t: number, total: number): number {
      const last = samples[samples.length - 1];
      if (last && total < last.total) samples = [];
      if (!samples.length) samples.push({ t: -Infinity, total: 0 });
      samples.push({ t, total });
      while (samples.length > 2 && samples[1].t <= t - windowMs) samples.shift();
      return total - samples[0].total;
    },
    /** Samples held (for the test of the bound). */
    size: () => samples.length,
  };
}

export type TopWarningKind = 'dropouts' | 'midi' | 'latency';
export interface TopWarning {
  kind: TopWarningKind;
  /** The badge's text: a few words. */
  label: string;
  /** Its tooltip: what is wrong and what a click does. */
  title: string;
}

export const BT_TIP = 'High output latency — Bluetooth headphones? Use wired output for playing live.';
export const MIDI_BLOCKED_TIP = 'MIDI access is blocked. Enable it in Chrome site settings (lock icon > Site settings > MIDI devices), then reload.';

/** The warning badge, or null (the normal state: nothing at the top right). Audio paused / failed is TopBar's (above). */
export function topWarning(o: { recentDrops: number; midi: MidiStatus['state']; latencyMs: number }): TopWarning | null {
  if (o.recentDrops > 0) {
    const n = o.recentDrops;
    return {
      kind: 'dropouts',
      label: `${n} dropout${n === 1 ? '' : 's'}`,
      title: `${n} audio dropout${n === 1 ? '' : 's'} in the last 10 s (the audio thread missed its deadline). Click for audio settings: a larger buffer helps.`,
    };
  }
  if (o.midi === 'denied') return { kind: 'midi', label: 'MIDI blocked', title: `${MIDI_BLOCKED_TIP} Click for MIDI.` };
  if (o.latencyMs > BT_LATENCY_MS) {
    return { kind: 'latency', label: `${Math.round(o.latencyMs)} ms latency`, title: `${BT_TIP} Click for audio settings.` };
  }
  return null;
}

/** Options ▸ MIDI…'s label after "MIDI: " (the device, or why there is none). */
export function midiLabel(m: MidiStatus): string {
  if (m.state === 'connected') return m.devices[0] + (m.devices.length > 1 ? ` +${m.devices.length - 1}` : '');
  return m.state === 'denied' ? 'blocked' : m.state === 'unsupported' ? 'unsupported' : 'no device';
}

/** Its tooltip (the full device list, or how to fix a block). */
export function midiTip(m: MidiStatus): string {
  if (m.state === 'denied') return MIDI_BLOCKED_TIP;
  if (m.state === 'unsupported') return 'This browser has no Web MIDI. Use Chrome.';
  return m.state === 'connected' ? `MIDI: ${m.devices.join(', ')}` : 'MIDI: no device connected';
}
