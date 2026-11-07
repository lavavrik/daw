// Click-to-preview for library samples (Browser pane).
//
// A preview is an AudioBufferSourceNode connected straight to the context's
// destination: it never goes through the engine (no track, no mixer, no
// command), so auditioning a sample cannot change the project or the
// worklet's sample arena. One preview at a time: starting another (or
// stop()) stops the current one at once. A decode that finishes after it
// was superseded or stopped is dropped (a token per play()), so a slow
// file never starts late over a newer one.
//
// Decoded buffers are cached by key (the library path), up to CACHE_SIZE,
// least recently used first out; clearCache() after a rescan, since a file
// at the same path may have changed.

/** The parts of a BaseAudioContext a preview needs (tests pass a fake). */
export type PreviewContext = Pick<BaseAudioContext, 'decodeAudioData' | 'createBufferSource' | 'destination'>;

export interface Preview {
  /** Key (library path) of the sample playing or decoding now, or null. */
  readonly current: string | null;
  /**
   * Stop whatever plays and start `key`. `load` gives the encoded bytes (it
   * is not called when `key` is cached). Rejects if reading or decoding
   * fails (nothing plays then); resolves once started or superseded.
   */
  play(key: string, load: () => Promise<ArrayBuffer>): Promise<void>;
  stop(): void;
  clearCache(): void;
}

const CACHE_SIZE = 16;

export function createPreview(ctx: PreviewContext, onChange: (key: string | null) => void): Preview {
  const cache = new Map<string, AudioBuffer>();
  let token = 0;
  let current: string | null = null;
  let src: AudioBufferSourceNode | null = null;

  const set = (k: string | null) => {
    if (k === current) return;
    current = k;
    onChange(k);
  };

  function halt() {
    const s = src;
    src = null;
    if (!s) return;
    s.onended = null;
    try {
      s.stop();
    } catch { /* never started */ }
    s.disconnect();
  }

  async function play(key: string, load: () => Promise<ArrayBuffer>) {
    const mine = ++token;
    halt();
    set(key);
    let buf = cache.get(key);
    if (!buf) {
      try {
        buf = await ctx.decodeAudioData(await load());
      } catch (e) {
        if (mine === token) set(null);
        throw e;
      }
      cache.set(key, buf);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    } else {
      cache.delete(key); // refresh its LRU position
      cache.set(key, buf);
    }
    if (mine !== token) return; // superseded or stopped meanwhile
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.onended = () => {
      if (src !== s) return;
      src = null;
      s.disconnect();
      set(null);
    };
    src = s;
    s.start();
  }

  return {
    get current() {
      return current;
    },
    play,
    stop() {
      token++;
      halt();
      set(null);
    },
    clearCache: () => cache.clear(),
  };
}
