// Builds a 16-bit mono PCM WAV (decaying-free sine) in Node for drop tests.
export function makeWav(freq = 100, ms = 50, sr = 48000): Buffer {
  const n = Math.round((sr * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 0.9 * 32767), 44 + i * 2);
  }
  return b;
}

/**
 * A 16-bit PCM WAV of deterministic white noise (`channels` independent LCG
 * streams). Unlike a sine it has one sharp cross-correlation peak, so a test
 * can find exactly where its audio landed in a render.
 */
export function makeNoiseWav(ms: number, channels = 1, sr = 48000, amp = 0.5, seed = 1): Buffer {
  const n = Math.round((sr * ms) / 1000);
  const bytes = n * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  let s = seed >>> 0;
  for (let i = 0; i < n * channels; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b.writeInt16LE(Math.round((s / 2 ** 32 - 0.5) * 2 * amp * 32767), 44 + i * 2);
  }
  return b;
}
