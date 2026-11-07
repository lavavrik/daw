import { describe, expect, it, vi } from 'vitest';
import { Op } from '../audio/protocol';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import { buildFixture, fakeDecoder, nullSink } from '../project/testFixture';
import { addDrumTrack, setRowSample, setStep } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { addClip } from '../state/song-actions';
import { sampleFile } from '../state/sampleFiles';
import { fakeAudio } from '../project/testFixture';
import { Project } from '../state/project.svelte';
import { ExportError, exportCommands, exportFileName, exportFrames, exportSong, songEndTicks } from './exportSong';
import { MAX_PARTS_IN_FLIGHT } from './render';
import { collect, fakeWorker } from './testWorker';

const ctx = { ...fakeDecoder, sampleRate: 48000 };

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
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, collect().write, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Nothing to export — the song has no clips. Add clips to the timeline in Song mode first.');
    expect(w.created).toBe(0); // no worker, no file
  });

  it('a sample that cannot be decoded is a clear error, not a hang', async () => {
    const { p } = await buildFixture();
    p.sampleFiles.get(1)!.bytes = new ArrayBuffer(0); // the fake decoder fails on empty bytes
    const { w, deps } = fakeWorker();
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, collect().write, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Export failed — sample "snare.wav" could not be decoded');
    expect(w.created).toBe(0);
  });

  it('cancel terminates the worker and rejects with AbortError', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker({ hold: true });
    const ac = new AbortController();
    const run = exportSong(p, ctx, () => {}, ac.signal, collect().write, deps);
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
    const out = collect();
    await exportSong(p, ctx, (f) => progress.push(f), new AbortController().signal, out.write, deps);
    const blob = out.blob();
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

  it('muted track at song start is silent in the export', async () => {
    // A hit on frame 0 of a muted drum track: the strip's mute must hold from
    // the first sample (not after the engine's first block).
    const p = new Project();
    const d = addDrumTrack(p, nullSink)!;
    p.sampleFiles.set(0, await sampleFile('kick.wav', 'audio/wav', fakeAudio(200))); // 200 frames of 0.5
    setRowSample(p, nullSink, d.id, d.rows[0].id, 0, 'kick');
    setStep(p, nullSink, d.id, d.rows[0].id, 0, 127);
    addClip(p, nullSink, d.id, { start: 0 });
    const sound = async () => {
      const out = collect();
      await exportSong(p, ctx, () => {}, new AbortController().signal, out.write, fakeWorker().deps);
      return new Uint8Array(await out.blob().arrayBuffer(), 44).some((b) => b !== 0);
    };
    expect(await sound()).toBe(true); // audible unmuted
    setMix(p, nullSink, d.id, 'mute', 1);
    expect(await sound()).toBe(false);
    setMix(p, nullSink, d.id, 'mute', 0);
    setMix(p, nullSink, d.id, 'fader', -60); // the fader's minimum is off
    expect(await sound()).toBe(false);
  });

  it('a worker that stops answering fails the export with a message (and is terminated)', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker({ hold: true, stallMs: 30 });
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, collect().write, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Export failed — the render stopped responding');
    expect(w.terminated).toBe(true);
  });

  it('a message the page cannot read (messageerror) fails the export', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker({ hold: true });
    const run = exportSong(p, ctx, () => {}, new AbortController().signal, collect().write, deps);
    await vi.waitFor(() => expect(w.onmessageerror).not.toBeNull());
    w.onmessageerror!({} as MessageEvent);
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Export failed — a message from the render worker could not be read');
    expect(w.terminated).toBe(true);
  });

  it('streams with bounded in-flight parts', async () => {
    // A disk that does not finish the first data write until released: the
    // worker parks after MAX_PARTS_IN_FLIGHT un-acked parts, so the page
    // never holds more than that, however fast the render is.
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker();
    const out = collect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    let maxInFlight = 0;
    const write = async (part: ArrayBuffer) => {
      calls++;
      maxInFlight = Math.max(maxInFlight, w.parts - w.acks); // delivered to the page, not yet acked
      if (calls === 2) await gate;
      await out.write(part);
    };
    const run = exportSong(p, ctx, () => {}, new AbortController().signal, write, deps);
    // The header was written and acked; then MAX_PARTS_IN_FLIGHT more parts.
    await vi.waitFor(() => expect(w.parts).toBe(1 + MAX_PARTS_IN_FLIGHT));
    await new Promise((r) => setTimeout(r, 50));
    expect(w.parts).toBe(1 + MAX_PARTS_IN_FLIGHT); // parked, not racing ahead
    expect(w.acks).toBe(1);
    expect(calls).toBe(2); // writes go one at a time, in order
    release();
    await run;
    expect(w.parts).toBeGreaterThan(MAX_PARTS_IN_FLIGHT + 2); // the fixture is ~8 parts long
    expect(maxInFlight).toBeLessThanOrEqual(MAX_PARTS_IN_FLIGHT);
    expect(out.blob().size).toBe(44 + exportFrames(serialize(p), 48000) * 6);
    expect(w.terminated).toBe(true);
  });

  it('a slow disk is not a stalled render (the watchdog waits for the writes)', async () => {
    const { p } = await buildFixture();
    const { deps } = fakeWorker({ stallMs: 100 });
    const out = collect();
    let n = 0;
    const write = async (part: ArrayBuffer) => {
      if (++n === 2) await new Promise((r) => setTimeout(r, 400)); // 4× the stall limit
      await out.write(part);
    };
    await exportSong(p, ctx, () => {}, new AbortController().signal, write, deps);
    expect(out.blob().size).toBe(44 + exportFrames(serialize(p), 48000) * 6);
  });

  it('a write that fails fails the export (and terminates the worker)', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker();
    const write = async () => Promise.reject(new Error('disk full'));
    const err = await exportSong(p, ctx, () => {}, new AbortController().signal, write, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect(err.message).toBe('Export failed — the file could not be written (disk full)');
    expect(w.terminated).toBe(true);
  });

  it('cancel mid-stream: no write after the abort', async () => {
    const { p } = await buildFixture();
    const { w, deps } = fakeWorker();
    const ac = new AbortController();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = async () => {
      if (++calls === 2) await gate;
    };
    const run = exportSong(p, ctx, () => {}, ac.signal, write, deps);
    await vi.waitFor(() => expect(calls).toBe(2));
    ac.abort();
    const err = await run.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(w.terminated).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
  });
});
