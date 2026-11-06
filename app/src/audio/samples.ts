// Turning a dropped file into engine-ready planar channels.

export class SampleDecodeError extends Error {
  constructor(public readonly fileName: string) {
    super(`Couldn't decode "${fileName}"`);
    this.name = 'SampleDecodeError';
  }
}

const AUDIO_EXT = /\.(wav|aif|aiff|mp3|flac|ogg|m4a)$/i;

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

/** Decode (resampled to the context rate by the browser); at most 2 channels. */
export async function decodeFile(
  file: File,
  ctx: BaseAudioContext,
): Promise<{ name: string; channels: Float32Array[] }> {
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new SampleDecodeError(file.name);
  }
  if (buf.length === 0 || buf.numberOfChannels === 0) throw new SampleDecodeError(file.name);
  const fade = Math.round(0.002 * buf.sampleRate); // 2 ms
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    const ch = buf.getChannelData(c).slice(); // own copy; fade in place
    fadeOutTail(ch, fade);
    channels.push(ch);
  }
  return { name: file.name.replace(/\.[^./\\]*$/, '') || file.name, channels };
}
