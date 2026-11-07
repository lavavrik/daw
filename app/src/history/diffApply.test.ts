import { describe, expect, it } from 'vitest';
import { MAX_CLIPS, MAX_NOTES, Op } from '../audio/protocol';
import { moduleDef, paramIndex } from '../audio/catalog';
import { addDrumTrack, addRow, removeTrack, selectTrack, setMetronome, setRowGain, setRowMute, setRowPan, setRowSample, setStep, setTempo, toggleStep } from '../state/actions';
import { setMix, setSidechain } from '../state/mixer-actions';
import { addNote, deleteNotes, deletePattern, duplicatePattern, newPattern, renamePattern, selectPattern, setPatternBars, updateNotes } from '../state/pattern-actions';
import { addModule, addSynthTrack, connect, disconnect, loadPatch, removeModule, setParam } from '../state/rack-actions';
import { deleteClips, duplicateClips, makeUnique, moveClips, resizeClip, setLoop, setMode, splitClips } from '../state/song-actions';
import { addAudioClip, addAudioTrack, setAudioClip, trimAudioClipStart } from '../state/audio-actions';
import { STARTER_PATCHES } from '../state/patches';
import { Project, currentPattern } from '../state/project.svelte';
import type { AudioTrack, DrumTrack, SynthTrack } from '../state/project.svelte';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { addAudioFixture, buildFixture, nullSink } from '../project/testFixture';
import { blankModel, run, view } from './engineModel';
import { diffApply } from './diffApply';

const ids = (json: ProjectJson) => new Map(json.samples.map((s) => [s.id, s.id]));
/** The engine state a fresh load of `json` builds. */
const loaded = (json: ProjectJson) => view(run(blankModel(), projectCommands(json, ids(json)).commands), json);

/**
 * The fixture project, with a modelled engine that holds it (as a load would
 * have built it) and a sink that logs every command into that model.
 */
async function rig(o: { audio?: boolean } = {}) {
  const f = await buildFixture();
  const audio = o.audio ? await addAudioFixture(f.p) : null;
  const A = serialize(f.p);
  const m = run(blankModel(), projectCommands(A, ids(A)).commands);
  const log: number[][] = [];
  const sink = {
    send(op: number, a = 0, b = 0, c = 0, d = 0) {
      log.push([op, a, b, c, d]);
      run(m, [[op, a, b, c, d]]);
      return true;
    },
  };
  return { ...f, audio, A, m, log, sink };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Edit, then diffApply back to A (undo) and forward to B (redo): each must leave UI and engine exactly as a load would. */
async function roundTrip(edit: (r: Rig) => void, atA?: (r: Rig) => void, o: { audio?: boolean } = {}) {
  const r = await rig(o);
  edit(r);
  const B = serialize(r.p);
  expect(B).not.toEqual(r.A);
  expect(r.m.errors).toEqual([]);
  diffApply(r.p, r.sink, B, r.A);
  expect(r.m.errors).toEqual([]);
  expect(serialize(r.p)).toEqual(r.A);
  expect(view(r.m, r.A)).toEqual(loaded(r.A));
  atA?.(r);
  diffApply(r.p, r.sink, r.A, B);
  expect(r.m.errors).toEqual([]);
  expect(serialize(r.p)).toEqual(B);
  expect(view(r.m, B)).toEqual(loaded(B));
  return r;
}

describe('diffApply', () => {
  it('diffApply sends only changed notes', async () => {
    const r = await rig();
    const s = r.synth;
    const pat = currentPattern(s);
    const before = serialize(r.p);
    updateNotes(r.p, r.sink, s.id, [{ id: pat.notes[0].id, pitch: 50 }]);
    const after = serialize(r.p);
    r.log.length = 0;
    diffApply(r.p, r.sink, after, before);
    expect(r.log).toEqual([[Op.NOTE_SET, s.slot * MAX_NOTES + pat.notes[0].idx, 48 * 128 + 100, 3840, 3840]]);
    expect(pat.notes[0].pitch).toBe(48);
    // A note's id survives (editor selections stay valid); nothing else moved.
    expect(serialize(r.p)).toEqual(before);
    r.log.length = 0;
    diffApply(r.p, r.sink, before, before);
    expect(r.log).toEqual([]);
  });

  it('undo remove track restores everything', async () => {
    // The synth has a modified rack (+ Reverb, SamplePlayer), notes in two
    // patterns, a clip, mixer params and a sidechain key in both directions.
    await roundTrip(
      ({ p, sink, synth }) => removeTrack(p, sink, synth.id),
      ({ p, synth, synth2 }) => {
        const s = p.tracks.find((t) => t.name === 'Bass') as SynthTrack;
        expect(s.slot).toBe(synth.slot);
        expect(s.modules).toHaveLength(10);
        expect(p.mixer.channels[s.id].key?.row).toBe(0); // keyed by the kick row
        expect(p.mixer.channels[synth2.id].key?.trackId).toBe(s.id); // keyed by the restored track
      },
    );
  });

  it('removing a key source track and a drum track restores keys and rows', () =>
    roundTrip(({ p, sink, drums }) => removeTrack(p, sink, drums.id)));

  it('steps, rows, swing and step count', () =>
    roundTrip(({ p, sink, drums }) => {
      toggleStep(p, sink, drums.id, drums.rows[0].id, 2);
      setStep(p, sink, drums.id, drums.rows[3].id, 63, 90);
      const row = addRow(p, sink, drums.id)!;
      setRowSample(p, sink, drums.id, row.id, 2, 'vox');
      setRowGain(p, sink, drums.id, row.id, 1.5);
      setStep(p, sink, drums.id, row.id, 1, 33);
      setRowMute(p, sink, drums.id, drums.rows[2].id, false);
      setRowPan(p, sink, drums.id, drums.rows[1].id, 0.5);
    }));

  it('notes in the current and in another pattern; bars', () =>
    roundTrip(({ p, sink, synth }) => {
      const cur = currentPattern(synth);
      addNote(p, sink, synth.id, { pitch: 70, start: 100, len: 50 });
      deleteNotes(p, sink, synth.id, [cur.notes[0].id]);
      setPatternBars(p, sink, synth.id, 3);
      selectPattern(p, sink, synth.id, synth.patterns[0].id);
      updateNotes(p, sink, synth.id, [{ id: synth.patterns[0].notes[1].id, start: 1920, vel: 20 }]);
    }));

  it('pattern create, duplicate, rename and delete', () =>
    roundTrip(({ p, sink, drums, synth }) => {
      newPattern(p, sink, drums.id);
      setStep(p, sink, drums.id, drums.rows[1].id, 7, 99);
      duplicatePattern(p, sink, synth.id);
      addNote(p, sink, synth.id, { pitch: 30, start: 0, len: 10 });
      renamePattern(p, sink, synth.id, synth.patterns[0].id, 'Intro');
      expect(deletePattern(p, sink, synth.id, synth.patterns[0].id)).toBe(true);
    }));

  it('rack modules, cables and params', () =>
    roundTrip(({ p, sink, synth }) => {
      setParam(p, sink, synth.id, 1, paramIndex(moduleDef('osc'), 'octave'), 1);
      removeModule(p, sink, synth.id, 4); // the filter (and its cables)
      const d = addModule(p, sink, synth.id, 'delay')!;
      connect(p, sink, synth.id, { m: 6, port: 0 }, { m: d, port: 0 });
      disconnect(p, sink, synth.id, { m: 7, port: 1 });
    }));

  it('a whole new patch', () => roundTrip(({ p, sink, synth2 }) => void loadPatch(p, sink, synth2.id, STARTER_PATCHES[3])));

  it('clips', () =>
    roundTrip(({ p, sink, drums, synth }) => {
      moveClips(p, sink, [drums.clips[0].id], 960);
      resizeClip(p, sink, drums.clips[1].id, { len: 100, offset: 20 });
      duplicateClips(p, sink, [synth.clips[0].id]);
      makeUnique(p, sink, drums.id, drums.clips[0].id);
      deleteClips(p, sink, [synth.clips[0].id]);
    }));

  it('mixer params and keys', () =>
    roundTrip(({ p, sink, drums, synth, synth2 }) => {
      setMix(p, sink, drums.id, 'fader', 2);
      setMix(p, sink, 'reverb', 'rev_size', 0.1);
      setMix(p, sink, 'master', 'limiter_ceiling', -6);
      setSidechain(p, sink, synth.id, null);
      setSidechain(p, sink, synth2.id, { trackId: drums.id, row: 1 });
      setSidechain(p, sink, drums.id, { trackId: synth.id, row: null });
    }));

  it('transport settings', () =>
    roundTrip(({ p, sink }) => {
      setTempo(p, sink, 90);
      setMetronome(p, sink, false);
      setLoop(p, sink, { on: false, start: 0, end: 3840 });
      setMode(p, sink, 'pattern');
    }));

  it('added tracks, and a slot that changed kind', () =>
    roundTrip(({ p, sink, synth2 }) => {
      removeTrack(p, sink, synth2.id);
      const d = addDrumTrack(p, sink)!; // takes synth2's slot
      expect(d.slot).toBe(synth2.slot);
      setStep(p, sink, d.id, d.rows[0].id, 0, 100);
      addSynthTrack(p, sink, 'Lead', STARTER_PATCHES[3]);
    }));

  it('selection and the live input follow the snapshot', async () => {
    await roundTrip(
      ({ p, sink, synth2 }) => {
        selectTrack(p, sink, synth2.id);
        setTempo(p, sink, 100);
      },
      // Back at A: the drums are selected, keys on the Bass synth (fixture).
      ({ p, m, drums, synth }) => {
        expect(p.selectedTrackId).toBe(drums.id);
        expect(m.input).toBe(synth.slot);
      },
    );
  });

  it('a project with no tracks and back', async () => {
    const p = new Project();
    addDrumTrack(p, nullSink);
    const A = serialize(p);
    const empty = serialize(new Project());
    const m = run(blankModel(), projectCommands(A, ids(A)).commands);
    const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (run(m, [[op, a, b, c, d]]), true) };
    diffApply(p, sink, A, empty);
    expect(p.tracks).toEqual([]);
    expect(view(m, empty)).toEqual(loaded(empty));
    diffApply(p, sink, empty, A);
    expect(serialize(p)).toEqual(A);
    expect(view(m, A)).toEqual(loaded(A));
    expect(m.errors).toEqual([]);
    expect((p.tracks[0] as DrumTrack).rows).toHaveLength(4);
  });

  it('every track\'s module removals go before any add (an effect moved between tracks is never refused)', async () => {
    const r = await rig();
    const A = r.A;
    const rev = r.synth.modules.find((m) => m.kind === moduleDef('reverb').kind)!.idx;
    removeModule(r.p, r.sink, r.synth.id, rev);
    addModule(r.p, r.sink, r.synth2.id, 'reverb');
    const B = serialize(r.p);
    r.log.length = 0;
    diffApply(r.p, r.sink, B, A); // the synth (earlier slot) gets its reverb back, synth2 loses its one
    const at = (op: number, slot: number) => r.log.findIndex((c) => c[0] === op && c[1] === slot);
    expect(at(Op.RACK_REMOVE_MODULE, r.synth2.slot)).toBeGreaterThanOrEqual(0);
    expect(at(Op.RACK_REMOVE_MODULE, r.synth2.slot)).toBeLessThan(at(Op.RACK_ADD_MODULE, r.synth.slot));
    expect(view(r.m, A)).toEqual(loaded(A));
    expect(r.m.errors).toEqual([]);
  });

  it('undo/redo audio clip edits', async () => {
    // A whole Audio track that comes and goes (trackState + trackCommands).
    await roundTrip(({ p, sink }) => {
      const t = addAudioTrack(p, sink)!;
      addAudioClip(p, sink, t.id, { sampleId: 0, start: 0, len: 960 });
    });
    // Per-clip diffs on existing Audio tracks: edits, a trim, a move between
    // audio lanes, a split, a delete, an add; and the strip's key.
    await roundTrip(({ p, sink, audio }) => {
      const { loop, vox } = audio!;
      setAudioClip(p, sink, loop.clips[0].id, { gain: -12, fadeIn: 100, loop: false });
      trimAudioClipStart(p, sink, vox.clips[0].id, vox.clips[0].start + 96);
      moveClips(p, sink, [loop.clips[1].id], 960, 1); // Loop -> Vox lane
      splitClips(p, sink, [vox.clips[0].id], vox.clips[0].start + 200);
      deleteClips(p, sink, [loop.clips[0].id]);
      addAudioClip(p, sink, loop.id, { sampleId: 1, start: 7680, len: 100 });
      setSidechain(p, sink, vox.id, null);
    }, undefined, { audio: true });
    // An Audio track removed, and its slot taken by another kind.
    await roundTrip(({ p, sink, audio }) => {
      removeTrack(p, sink, audio!.vox.id);
      addDrumTrack(p, sink);
    }, undefined, { audio: true });
  });

  it('diffApply re-sends only the audio clips that changed, keeping their ids', async () => {
    const r = await rig({ audio: true });
    const loop = r.audio!.loop as AudioTrack;
    const [a, b] = loop.clips;
    const before = serialize(r.p);
    setAudioClip(r.p, r.sink, a.id, { gain: -20 });
    const after = serialize(r.p);
    r.log.length = 0;
    diffApply(r.p, r.sink, after, before);
    const at = loop.slot * MAX_CLIPS + a.idx;
    expect(r.log.map((c) => [c[0], c[1]])).toEqual([[Op.AUDIO_CLIP_SOURCE, at], [Op.AUDIO_CLIP_GAIN, at], [Op.AUDIO_CLIP_SET, at]]);
    expect(loop.clips[0]).toBe(a);
    expect(loop.clips[1]).toBe(b);
    expect(a.gain).toBe(-3);
    expect(view(r.m, before)).toEqual(loaded(before));
    expect(r.m.errors).toEqual([]);
  });
});
