// Turning a dropped file into engine-ready planar channels, and engine load
// failures into words a user understands.
import { Err, HostErr, MAX_ARENA_FLOATS, MAX_SAMPLE_FLOATS } from './protocol';
import { MAX_SAMPLES } from '../state/project.svelte';

export class SampleDecodeError extends Error {
  constructor(public readonly fileName: string) {
    super(`Couldn't decode "${fileName}"`);
    this.name = 'SampleDecodeError';
  }
}

/** The audio file extensions the app accepts (drops, library folder scan). */
export const AUDIO_EXT = /\.(wav|aif|aiff|mp3|flac|ogg|m4a)$/i;

export function isProbablyAudio(file: File): boolean {
  return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
}

/**
 * Linear fade to exactly 0 over the last `frames` samples (or the whole
 * buffer if shorter). Anti-click insurance for samples that end mid-wave:
 * the voice's last sample is then 0, so ending it can't produce a step.
 */
export function fadeOutTail(ch: Float32Array, frames: number): void {
  const n = Math.min(Math.max(0, Math.floor(frames)), ch.length);
  for (let i = 0; i < n; i++) ch[ch.length - n + i] *= (n - 1 - i) / n;
}

/** What decoding needs from an AudioContext (tests pass a fake). */
export type SampleDecoder = Pick<BaseAudioContext, 'decodeAudioData'>;

/**
 * Decode encoded audio (resampled to the context rate by the browser); at
 * most 2 channels, each with a 2 ms fade-out tail. `bytes` is detached by
 * decodeAudioData: pass a copy if you keep the original (sample files).
 * Throws SampleDecodeError(`name`).
 */
export async function decodeBytes(bytes: ArrayBuffer, name: string, ctx: SampleDecoder): Promise<Float32Array[]> {
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    throw new SampleDecodeError(name);
  }
  if (buf.length === 0 || buf.numberOfChannels === 0) throw new SampleDecodeError(name);
  const fade = Math.round(0.002 * buf.sampleRate); // 2 ms
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const ch = buf.getChannelData(c).slice(); // own copy; fade in place
    fadeOutTail(ch, fade);
    channels.push(ch);
  }
  return channels;
}

/** "kick.wav" -> "kick" (the row name). */
export const baseName = (fileName: string): string => fileName.replace(/\.[^./\\]*$/, '') || fileName;

/** Decode a dropped file (see decodeBytes). */
export async function decodeFile(file: File, ctx: SampleDecoder): Promise<{ name: string; channels: Float32Array[] }> {
  return { name: baseName(file.name), channels: await decodeBytes(await file.arrayBuffer(), file.name, ctx) };
}

/**
 * Why a sample failed to load, in plain words (completes "Couldn't load
 * "x" — …"). `code` is a failed Err / HostErr result of loadSample or of a
 * deferred retry; `sampleRate` is the engine's, for the length limit.
 */
export function loadErrorText(code: number, sampleRate: number): string {
  switch (code) {
    case Err.BAD_VALUE: {
      // decodeFile always yields 1-2 non-empty channels, so it's the size cap.
      const min = (ch: number) => Math.floor(MAX_SAMPLE_FLOATS / ch / sampleRate / 60);
      return `too long (max ~${min(1)} min mono / ~${min(2)} min stereo at ${sampleRate / 1000} kHz)`;
    }
    case Err.OUT_OF_MEMORY:
      return `not enough sample memory (${MAX_ARENA_FLOATS / 262144 / 1024} GB limit; removed samples free on reopen)`;
    case Err.BAD_INDEX:
      return `sample limit reached (${MAX_SAMPLES} loads per session)`;
    case HostErr.QUEUE_FULL:
      return 'too many samples were waiting for playback to stop — drop it again';
    case HostErr.ENGINE_STOPPED:
      return 'the audio engine has stopped (reload the page)';
    case HostErr.RESET:
      return 'a new project was loaded before it could load';
    default:
      return `unexpected engine error (code ${code})`;
  }
}
