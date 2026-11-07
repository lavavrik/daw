// Offline WAV export of the song (docs/architecture/export.md).
//
// Main thread: snapshot the project (serialize), decode its samples with the
// project AudioContext's decodeAudioData (Workers have none) -- the same
// decodeBytes the live load uses, so the engine gets the same data -- build
// the command list with projectCommands (the one replay-order builder), and
// hand everything to a dedicated Worker (renderWorker.ts) as transferables.
// The Worker instantiates the same engine.wasm and renders faster than real
// time; the live AudioContext and engine are never touched, so playback and
// the UI carry on.
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
import type { JobSample, RenderRequest, WorkerReply } from './render';

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
  postMessage(msg: RenderRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface ExportDeps {
  worker(): RenderWorker;
  /** The engine.wasm bytes (the same file the worklet runs). */
  wasm(): Promise<ArrayBuffer>;
}

const defaultDeps: ExportDeps = {
  worker: () => new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' }) as RenderWorker,
  wasm: async () => {
    const r = await fetch('/engine.wasm');
    if (!r.ok) throw new ExportError(`Export failed — engine.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  },
};

/** Song end in ticks: the end of the last clip (0 = no clips, nothing to export). */
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
 * Renders the song to a 24-bit WAV Blob. `onProgress(fraction)` follows the
 * Worker (every 0.25 s of audio, 1 at the end). Aborting `signal` terminates
 * the Worker and rejects with an AbortError. Other failures reject with an
 * ExportError whose message is meant for the user; an empty song fails
 * before any Worker exists.
 */
export async function exportSong(
  p: Project, ctx: SampleDecoder & { readonly sampleRate: number }, onProgress: (fraction: number) => void,
  signal: AbortSignal, deps: ExportDeps = defaultDeps,
): Promise<Blob> {
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
  return new Promise<Blob>((resolve, reject) => {
    const finish = (fn: () => void) => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(aborted()));
    signal.addEventListener('abort', onAbort);
    worker.onerror = (e) => {
      e.preventDefault?.();
      finish(() => reject(new ExportError(`Export failed — the render worker crashed${e.message ? ` (${e.message})` : ''}`)));
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.fraction);
      else if (m.type === 'done') finish(() => resolve(m.wav));
      else if (m.type === 'error') finish(() => reject(new ExportError(`Export failed — ${m.message}`)));
    };
    worker.postMessage({ type: 'render', wasm, job }, [wasm, ...samples.map((s) => s.data.buffer)]);
  });
}
