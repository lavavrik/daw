import { describe, expect, it } from 'vitest';
import { Op } from '../audio/protocol';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import { buildFixture, fakeDecoder, nullSink } from '../project/testFixture';
import { addDrumTrack } from '../state/actions';
import { Project } from '../state/project.svelte';
import { ExportError, exportCommands, exportFileName, exportFrames, exportSong, songEndTicks } from './exportSong';
import type { RenderWorker } from './exportSong';
import { handleRenderMessage } from './render';
import { engineWasmBytes } from './testWasm';
import type { WorkerReply } from './render';

const ctx = { ...fakeDecoder, sampleRate: 48000 };

/** A Worker stand-in running the real render core in this thread (asynchronously, like a Worker). */
function fakeWorker(o: { hold?: boolean } = {}) {
  const w = {
    created: 0,
    terminated: false,
    posted: null as unknown,
    onmessage: null as ((e: MessageEvent<WorkerReply>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    postMessage(msg: unknown) {
      w.posted = msg;
      if (o.hold) return; // never answers (cancel test)
      setTimeout(() => {
        if (w.terminated) return;
        handleRenderMessage(msg, (reply) => !w.terminated && w.onmessage?.({ data: reply } as MessageEvent<WorkerReply>));
      }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const deps = {
    worker: () => {
      w.created++;
      return w as unknown as RenderWorker;
    },
    wasm: async () => engineWasmBytes(),
  };
  return { w, deps };
}

describe('export: what gets rendered', () => {
  it('song end is the end of the last clip', async () => {
    const { p } = await buildFixture();
    // Clips: drums 0..3840 and 3840..11520, synth pattern 2 (2 bars) at 0.
    expect(songEndTicks(serialize(p))).toBe(11520);
    expect(songEndTicks(serialize(new Project()))).toBe(0);
  });

  it('frames = song end at the project tempo plus a 2 s tail', async () => {
    const { p } = await buildFixture();
    const json = serialize(p);
    // 11520 ticks = 12 beats at 132.5 BPM.
    expect(exportFrames(json, 48000)).toBe(Math.round(((12 * 60) / 132.5) * 48000) + 2 * 48000);
  });

  it('commands: the project replay, metronome off, Song mode from 0, loop off, then PLAY', async () => {
    const { p } = await buildFixture(); // metronome on, loop on, Song mode
    const json = serialize(p);
    const ids = new Map(json.samples.map((s) => [s.id, s.id]));
    const cmds = exportCommands(json, ids).commands;
    const replay = projectCommands(json, ids).commands;
    const tracks = replay.slice(0, replay.findIndex((c) => c[0] === Op.SET_TEMPO));
    expect(cmds.slice(0, tracks.length)).toEqual(tracks); // the one builder's order
    const transport = cmds.slice(tracks.length);
    expect(transport).toContainEqual([Op.SET_METRONOME, 0]);
    expect(transport).toContainEqual([Op.SET_MODE, 1]);
    expect(transport).toContainEqual([Op.SET_LOOP, 0, 0]);
    expect(transport.slice(-2)).toEqual([[Op.SEEK, 0], [Op.PLAY, 0]]);
    expect(cmds.filter((c) => c[0] === Op.SET_METRONOME)).toEqual([[Op.SET_METRONOME, 0]]);
  });

  it('file name is "<project name> <YYYY-MM-DD>.wav", made safe', () => {
    expect(exportFileName('My Song', new Date(2026, 10, 7, 23, 59))).toBe('My Song 2026-11-07.wav');
    expect(exportFileName('a/b:c', new Date(2026, 0, 2))).toBe('a_b_c 2026-01-02.wav');
    expect(exportFileName('  ', new Date(2026, 0, 2))).toBe('Untitled 2026-01-02.wav');
  });
});

describe('exportSong', () => {
  it('empty song shows message', async () => {
    const p = new Project();
    addDrumTrack(p, nullSink); // a track, but no clips on the timeline
    const { w, deps } = fakeWorker();
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Nothing to export — the song has no clips. Add clips to the timeline in Song mode first.');
    expect(w.created).toBe(0); // no worker, no file
  });

  it('a sample that cannot be decoded is a clear error, not a hang', async () => {
    const { p } = await buildFixture();
    p.sampleFiles.get(1)!.bytes = new ArrayBuffer(0); // the fake decoder fails on empty bytes
    const { w, deps } = fakeWorker();
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Export failed — sample "snare.wav" could not be decoded');
    expect(w.created).toBe(0);
  });

  it('cancel terminates the worker and rejects with AbortError', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker({ hold: true });
    const ac = new AbortController();
    const run = exportSong(p, ctx, () => {}, ac.signal, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.created).toBe(1);
    ac.abort();
    const err = await run.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(w.terminated).toBe(true);
  });

  it('renders the song through the real engine: right length, not silent, progress to 1', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker();
    const progress: number[] = [];
    const blob = await exportSong(p, ctx, (f) => progress.push(f), new AbortController().signal, deps);
    const frames = exportFrames(serialize(p), 48000);
    expect(blob.size).toBe(44 + frames * 6);
    const pcm = new Uint8Array(await blob.arrayBuffer(), 44);
    expect(pcm.some((b) => b !== 0)).toBe(true);
    // Every 0.25 s of audio, increasing, ending at 1.
    expect(progress.length).toBeGreaterThanOrEqual(Math.floor(frames / 12000));
    expect(progress.every((f, i) => i === 0 || f > progress[i - 1])).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(w.terminated).toBe(true); // released once done
    // The job sent: the wasm, the export command list, the decoded samples (transferred).
    const { job } = w.posted as { job: { commands: number[][]; samples: { id: number }[] } };
    const json = serialize(p);
    expect(job.commands).toEqual(exportCommands(json, new Map(json.samples.map((s) => [s.id, s.id]))).commands);
    expect(job.samples.map((s) => s.id)).toEqual([0, 1, 2]);
  });
});
