// Click-to-preview for library samples (Browser pane).
//
// A preview never goes through the engine (no track, no mixer, no command),
// so auditioning a sample cannot change the project or the worklet's sample
// arena. One preview at a time: starting another (or stop()) stops the
// current one at once. Work that finishes after it was superseded or
// stopped is dropped (a token per play()), so a slow file never starts late
// over a newer one.
//
// Two ways to play, by file size (memory: plan 6 Task 5 review item 1):
//   - small files are decoded (decodeAudioData) and played by an
//     AudioBufferSourceNode to the context's destination; instant replays;
//   - big files would decode to huge buffers (a 1 h WAV ≈ 1.4 GB of floats,
//     and compressed formats expand ~10x), so above `streamBytes` (50 MB;
//     `streamCompressedBytes`, 5 MB, for mp3/ogg/m4a/flac/aac) they are
//     streamed by an HTMLAudioElement from an object URL, which the browser
//     decodes as it plays. The URL is revoked when it stops or ends.
//
// Decoded buffers are cached by key (the library path), bounded by memory:
// at most `cacheFloats` floats in all (32M = 128 MB), least recently used
// out first, and no buffer longer than `maxCacheSeconds` (30 s) is kept.
// clearCache() after a rescan, since a file at the same path may have changed.

/** The parts of a BaseAudioContext a preview needs (tests pass a fake). */
export type PreviewContext = Pick<BaseAudioContext, 'decodeAudioData' | 'createBufferSource' | 'destination'>;

/** A streaming player started on `blob`; `onEnded` when it finishes by itself. Rejects if it cannot play. */
export type Streamer = (blob: Blob, onEnded: () => void) => Promise<{ stop(): void }>;

export interface PreviewOptions {
  cacheFloats?: number;
  maxCacheSeconds?: number;
  streamBytes?: number;
  streamCompressedBytes?: number;
  stream?: Streamer;
}

export interface Preview {
  /** Key (library path) of the sample playing or loading now, or null. */
  readonly current: string | null;
  /**
   * Stop whatever plays and start `key`. `load` gives the file (not called
   * when `key` is cached; a disk File is not read into memory before the
   * size decides). Rejects if reading, decoding or streaming fails (nothing
   * plays then); resolves once started or superseded.
   */
  play(key: string, load: () => Promise<Blob>): Promise<void>;
  stop(): void;
  clearCache(): void;
  /** Cache contents, least recently used first (tests). */
  cachedKeys(): string[];
  cachedFloats(): number;
}

const MB = 1 << 20;
const COMPRESSED = /\.(mp3|ogg|oga|m4a|aac|flac|opus)$/i;
const COMPRESSED_TYPE = /^audio\/(mpeg|mp3|ogg|mp4|x-m4a|aac|flac|x-flac|opus)/i;

/** The browser's own streaming playback (default output, not the engine). */
export const htmlAudioStreamer: Streamer = async (blob, onEnded) => {
  const url = URL.createObjectURL(blob);
  const a = new Audio();
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    a.onended = null;
    a.pause();
    a.removeAttribute('src');
    a.load(); // drop the media resource
    URL.revokeObjectURL(url);
  };
  a.onended = () => {
    stop();
    onEnded();
  };
  a.src = url;
  try {
    await a.play();
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
};

export function createPreview(ctx: PreviewContext, onChange: (key: string | null) => void, opts: PreviewOptions = {}): Preview {
  const cacheFloats = opts.cacheFloats ?? 32 * MB;
  const maxCacheSeconds = opts.maxCacheSeconds ?? 30;
  const streamBytes = opts.streamBytes ?? 50 * MB;
  const streamCompressedBytes = opts.streamCompressedBytes ?? 5 * MB;
  const stream = opts.stream ?? htmlAudioStreamer;

  const cache = new Map<string, AudioBuffer>(); // insertion order = LRU order
  let floats = 0;
  let token = 0;
  let current: string | null = null;
  /** Stops what plays now (a buffer source or a stream). */
  let halt: (() => void) | null = null;

  const set = (k: string | null) => {
    if (k === current) return;
    current = k;
    onChange(k);
  };
  const size = (b: AudioBuffer) => b.length * b.numberOfChannels;
  const drop = (k: string) => {
    const b = cache.get(k);
    if (!b) return;
    floats -= size(b);
    cache.delete(k);
  };

  function remember(key: string, buf: AudioBuffer) {
    if (buf.duration > maxCacheSeconds || size(buf) > cacheFloats) return;
    drop(key);
    cache.set(key, buf);
    floats += size(buf);
    while (floats > cacheFloats) drop(cache.keys().next().value!);
  }

  function stopNow() {
    const h = halt;
    halt = null;
    h?.();
  }

  /** Play `buf` to the destination; it clears `current` when it ends by itself. */
  function start(buf: AudioBuffer) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    const h = () => {
      s.onended = null;
      try {
        s.stop();
      } catch { /* never started */ }
      s.disconnect();
    };
    s.onended = () => {
      if (halt !== h) return;
      halt = null;
      s.disconnect();
      set(null);
    };
    halt = h;
    s.start();
  }

  async function play(key: string, load: () => Promise<Blob>) {
    const mine = ++token;
    stopNow();
    set(key);
    const fail = (e: unknown) => {
      if (mine === token) set(null);
      throw e;
    };
    let buf = cache.get(key);
    if (buf) {
      drop(key);
      remember(key, buf); // most recently used now
      return start(buf);
    }
    let blob: Blob;
    try {
      blob = await load();
    } catch (e) {
      return fail(e);
    }
    if (mine !== token) return;
    const compressed = COMPRESSED.test(key) || COMPRESSED_TYPE.test(blob.type);
    if (blob.size > (compressed ? streamCompressedBytes : streamBytes)) {
      // `h` exists before stream() starts: onEnded may fire while it is
      // still starting (a very short file), before `s` is known.
      let s: { stop(): void } | null = null;
      let ended = false;
      const h = () => s?.stop();
      try {
        s = await stream(blob, () => {
          ended = true;
          if (halt !== h) return;
          halt = null;
          set(null);
        });
      } catch (e) {
        return fail(e);
      }
      if (mine !== token) return s.stop(); // superseded while starting
      if (ended) return set(null); // already over
      halt = h;
      return;
    }
    try {
      buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (e) {
      return fail(e);
    }
    remember(key, buf);
    if (mine !== token) return; // superseded or stopped meanwhile
    start(buf);
  }

  return {
    get current() {
      return current;
    },
    play,
    stop() {
      token++;
      stopNow();
      set(null);
    },
    clearCache() {
      cache.clear();
      floats = 0;
    },
    cachedKeys: () => [...cache.keys()],
    cachedFloats: () => floats,
  };
}
