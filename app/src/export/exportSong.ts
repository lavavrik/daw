// Offline WAV export of the song (docs/architecture/export.md).
//
// Main thread: snapshot the project (serialize), decode its samples with the
// project AudioContext's decodeAudioData (Workers have none; audio clips'
// samples included, serialize lists them like rows') -- the same
// decodeBytes the live load uses, so the engine gets the same data -- build
// the command list with projectCommands (the one replay-order builder), and
// hand everything to a dedicated Worker (renderWorker.ts) as transferables.
// The Worker instantiates the same engine.wasm and renders faster than real
// time; the live AudioContext and engine are never touched, so playback and
// the UI carry on. The WAV comes back as a stream of parts (header first),
// each handed to `write` in order and acked to the Worker once written; the
// Worker parks after MAX_PARTS_IN_FLIGHT un-acked parts, so a slow disk
// bounds memory instead of letting parts pile up here.
//
// What is rendered: Song mode from tick 0 to the end of the last clip, plus
// a 2 s tail (reverb/delay/release ring-out), with the loop off and the
// METRONOME ALWAYS OFF whatever the UI says, through the master limiter as
// live. 24-bit PCM stereo at the project (AudioContext) sample rate.
import { BAR_TICKS, Op } from '../audio/protocol';
import { decodeBytes } from '../audio/samples';
import type { SampleDecoder } from '../audio/samples';
import { projectCommands } from '../project/commands';
import type { EngineCommand } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import type { Project } from '../state/project.svelte';
import type { JobSample, WorkerReply, WorkerRequest } from './render';

/** Seconds of tail rendered after the last clip ends. */
export const TAIL_SECONDS = 2;

/** An export that cannot run or failed; `message` is ready for a banner. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export const EMPTY_SONG = 'Nothing to export — the song has no clips. Add clips to the timeline in Song mode first.';

/** The slice of Worker the export uses (tests pass a fake). */
export interface RenderWorker {
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  terminate(): void;
}

export interface ExportDeps {
  worker(): RenderWorker;
  /** The engine.wasm bytes (the same file the worklet runs). */
  wasm(): Promise<ArrayBuffer>;
  /** No message from the Worker for this long = it is stuck (default STALL_MS). */
  stallMs?: number;
}

/**
 * The Worker posts progress every 0.25 s of audio (and once right after its
 * setup) and a part every 1 s of audio, i.e. every few milliseconds at ~50×
 * real time: 10 s of silence means it hung or died without an error event.
 * The watchdog only runs while no part is waiting to be written: a Worker
 * parked on back-pressure is waiting for the disk, not stuck.
 */
export const STALL_MS = 10_000;

const defaultDeps: ExportDeps = {
  worker: () => new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' }) as RenderWorker,
  wasm: async () => {
    const r = await fetch('/engine.wasm');
    if (!r.ok) throw new ExportError(`Export failed — engine.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  },
};

/** Song end in ticks: the end of the last clip, pattern or audio clip (0 = no clips, nothing to export). */
export function songEndTicks(json: ProjectJson): number {
  let end = 0;
  for (const t of json.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.len);
  return end;
}

/** Output frames: the song at the project tempo, plus the tail. */
export function exportFrames(json: ProjectJson, sampleRate: number): number {
  const seconds = (songEndTicks(json) / (BAR_TICKS / 4)) * (60 / json.tempo);
  return Math.round(seconds * sampleRate) + TAIL_SECONDS * sampleRate;
}

/**
 * The commands for a blank engine: the project's replay (projectCommands,
 * with metronome off, Song mode and the loop off), then SEEK 0 and PLAY.
 */
export function exportCommands(json: ProjectJson, sampleIds: Map<number, number>): { commands: EngineCommand[] } {
  const asExported: ProjectJson = { ...json, metronome: false, mode: 'song', loop: { ...json.loop, on: false } };
  const { commands } = projectCommands(asExported, sampleIds);
  return { commands: [...commands, [Op.SEEK, 0], [Op.PLAY, 0]] };
}

/** "<project name> <YYYY-MM-DD>.wav" (local date), the name made safe for any file system. */
export function exportFileName(name: string, date = new Date()): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'Untitled';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${safe} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.wav`;
}

const aborted = () => new DOMException('Export cancelled', 'AbortError');

/**
 * Renders the song to a 24-bit WAV, streamed: `write(part)` gets the file's
 * bytes in order (the 44-byte header first, final since the length is known,
 * then ~1 s of audio per part), one call at a time; the next part waits for
 * the previous write to resolve. Resolves once the last part is written.
 * `onProgress(fraction)` follows the Worker (every 0.25 s of audio, 1 at the
 * end). Aborting `signal` terminates the Worker and rejects with an
 * AbortError; no `write` starts after that. Other failures (a write that
 * rejects included) reject with an ExportError whose message is meant for
 * the user; an empty song fails before any Worker exists. The caller owns
 * what was written so far (exportFlow aborts the file's writable).
 */
export async function exportSong(
  p: Project, ctx: SampleDecoder & { readonly sampleRate: number }, onProgress: (fraction: number) => void,
  signal: AbortSignal, write: (part: ArrayBuffer) => Promise<void>, deps: ExportDeps = defaultDeps,
): Promise<void> {
  const json = serialize(p); // a snapshot: edits made during the export do not change it
  if (songEndTicks(json) === 0) throw new ExportError(EMPTY_SONG);
  const sampleRate = ctx.sampleRate;

  // serialize lists exactly the samples the project uses and has bytes for,
  // under their engine ids (p.sampleFiles keys), so the ids map to themselves.
  const samples: JobSample[] = [];
  for (const s of json.samples) {
    const file = p.sampleFiles.get(s.id)!;
    let channels: Float32Array[];
    try {
      channels = await decodeBytes(file.bytes.slice(0), file.name, ctx); // decode detaches: a copy
    } catch {
      throw new ExportError(`Export failed — sample "${file.name}" could not be decoded`);
    }
    const frames = channels[0].length;
    const data = new Float32Array(frames * channels.length);
    channels.forEach((ch, i) => data.set(ch, i * frames));
    samples.push({ id: s.id, frames, channels: channels.length, data });
  }
  if (signal.aborted) throw aborted();
  const ids = new Map(json.samples.map((s) => [s.id, s.id]));
  const job = { sampleRate, frames: exportFrames(json, sampleRate), samples, commands: exportCommands(json, ids).commands };
  const wasm = await deps.wasm();
  if (signal.aborted) throw aborted();

  const worker = deps.worker();
  return new Promise<void>((resolve, reject) => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let unwritten = 0; // parts received, not yet written (and acked)
    let writes = Promise.resolve(); // the parts' writes, in order
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    const fail = (why: string) => finish(() => reject(new ExportError(`Export failed — ${why}`)));
    /** Restarts the stall watchdog, unless the Worker may be waiting on our writes. */
    const alive = () => {
      clearTimeout(watchdog);
      if (settled || unwritten > 0) return;
      watchdog = setTimeout(() => fail('the render stopped responding'), deps.stallMs ?? STALL_MS);
    };
    const onAbort = () => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort);
    worker.onmessageerror = () => fail('a message from the render worker could not be read');
    worker.onerror = (e) => {
      e.preventDefault?.();
      fail(`the render worker crashed${e.message ? ` (${e.message})` : ''}`);
    };
    worker.onmessage = (e) => {
      if (settled) return;
      const m = e.data;
      if (m.type === 'progress') {
        alive();
        onProgress(m.fraction);
      } else if (m.type === 'part') {
        unwritten++;
        alive(); // a part is progress too: it pauses the watchdog until written
        writes = writes.then(
          async () => {
            if (settled) return; // cancelled or failed: nothing more goes to the file
            await write(m.bytes);
            if (settled) return;
            unwritten--;
            worker.postMessage({ type: 'ack' });
            alive();
          },
        ).catch((err) => fail(`the file could not be written (${err instanceof Error ? err.message : String(err)})`));
      } else if (m.type === 'done') {
        void writes.then(() => finish(resolve)); // every part is queued before 'done'
      } else if (m.type === 'error') fail(m.message);
    };
    alive();
    worker.postMessage({ type: 'render', wasm, job }, [wasm, ...samples.map((s) => s.data.buffer)]);
  });
}
