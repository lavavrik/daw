// Test helper (not a test file): a render Worker stand-in that runs the real
// render core (render.ts renderService) in this thread, asynchronously like a
// Worker, plus a part sink that collects what exportSong streams.
import type { ExportDeps, RenderWorker } from './exportSong';
import { renderService } from './render';
import type { WorkerReply, WorkerRequest } from './render';
import { engineWasmBytes } from './testWasm';

/**
 * `hold`: the "worker" never answers (cancel / stall tests). `posted` is the
 * render request (its job intact: nothing is really transferred here);
 * `parts` counts the parts delivered to the page, `acks` the acks it sent
 * back.
 */
export function fakeWorker(o: { hold?: boolean; stallMs?: number } = {}) {
  const w = {
    created: 0,
    terminated: false,
    posted: null as unknown,
    parts: 0,
    acks: 0,
    onmessage: null as ((e: MessageEvent<WorkerReply>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as ((e: MessageEvent) => void) | null,
    service: null as ((msg: unknown) => void) | null,
    postMessage(msg: WorkerRequest) {
      if (msg.type === 'render') w.posted = msg;
      else w.acks++;
      if (o.hold) return; // never answers
      w.service ??= renderService((reply) => {
        if (w.terminated) return;
        if (reply.type === 'part') w.parts++;
        w.onmessage?.({ data: reply } as MessageEvent<WorkerReply>);
      });
      setTimeout(() => !w.terminated && w.service!(msg), 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const deps: ExportDeps = {
    worker: () => {
      w.created++;
      return w as unknown as RenderWorker;
    },
    wasm: async () => engineWasmBytes(),
    stallMs: o.stallMs,
  };
  return { w, deps };
}

/** A part sink that keeps every part; `blob()` is the file as written. */
export function collect() {
  const parts: ArrayBuffer[] = [];
  return {
    parts,
    write: async (part: ArrayBuffer) => void parts.push(part),
    blob: () => new Blob(parts, { type: 'audio/wav' }),
  };
}
