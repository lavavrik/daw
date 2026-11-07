// Randomized property test of the undo history (plan 8, "Correctness
// first"): structural sharing and lazy recording snapshots must never corrupt
// an undo. For many seeded random sequences of mixed edits (one-shots,
// gestures, recording passes, pattern / track switches that are not edits,
// track adds and removes, undo/redo in between), undoing everything restores
// the project as it was before the first entry, and redoing it all restores
// the final state; the modelled engine matches a fresh load of each.
import { describe, expect, it } from 'vitest';
import { moduleDef, paramIndex } from '../audio/catalog';
import { addDrumTrack, removeTrack, selectTrack, setTempo, toggleStep } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { addNote, deleteNotes, newPattern, selectPattern, updateNotes } from '../state/pattern-actions';
import { addSynthTrack, setParam } from '../state/rack-actions';
import { edit } from '../state/edits';
import { currentPattern } from '../state/project.svelte';
import type { DrumTrack, SynthTrack, Track } from '../state/project.svelte';
import { projectCommands } from '../project/commands';
import { serialize } from '../project/serialize';
import type { ProjectJson } from '../project/schema';
import { buildFixture } from '../project/testFixture';
import { blankModel, run, view } from './engineModel';
import { createHistory } from './history';
import { diffApply } from './diffApply';

/** mulberry32: a small seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[int(xs.length)] : undefined) };
}

const ids = (json: ProjectJson) => new Map(json.samples.map((s) => [s.id, s.id]));
const loaded = (json: ProjectJson) => view(run(blankModel(), projectCommands(json, ids(json)).commands), json);

async function sequence(seed: number, ops: number) {
  const r = rng(seed);
  const { p } = await buildFixture();
  const start = serialize(p);
  const m = run(blankModel(), projectCommands(start, ids(start)).commands);
  const sink = { send: (op: number, a = 0, b = 0, c = 0, d = 0) => (run(m, [[op, a, b, c, d]]), true) };
  const coalesceTask = seed % 2 === 0;
  const h = createHistory({ snapshot: () => serialize(p), apply: (from, to) => diffApply(p, sink, from, to), coalesceTask });
  p.history = h;

  const synths = () => p.tracks.filter((t): t is SynthTrack => t.kind === 'synth');
  const drums = () => p.tracks.filter((t): t is DrumTrack => t.kind === 'drum');
  let pass = 1;
  const recNote = (t: SynthTrack) =>
    edit(p, 'Record', () => addNote(p, sink, t.id, { pitch: 30 + r.int(60), start: r.int(3840), len: 1 + r.int(400) }), { coalesce: `rec:${pass}` });
  // 0 - n: never -0 (toEqual tells it from 0).
  const fader = (t: Track) => setMix(p, sink, t.id, 'fader', 0 - r.int(40));

  const menu: ((log: string[]) => void)[] = [
    (log) => {
      const d = r.pick(drums());
      if (d) (log.push('toggleStep'), toggleStep(p, sink, d.id, d.rows[r.int(d.rows.length)].id, r.int(16)));
    },
    (log) => {
      const t = r.pick(p.tracks);
      if (t) (log.push('fader'), fader(t));
    },
    (log) => (log.push('reverb'), setMix(p, sink, 'reverb', 'rev_size', r.next())),
    (log) => {
      const t = r.pick(synths());
      if (t) (log.push('addNote'), addNote(p, sink, t.id, { pitch: 30 + r.int(60), start: r.int(3840), len: 1 + r.int(400) }));
    },
    (log) => {
      const t = r.pick(synths());
      const n = t && r.pick(currentPattern(t).notes);
      if (t && n) (log.push('updateNotes'), updateNotes(p, sink, t.id, [{ id: n.id, pitch: 30 + r.int(60), start: r.int(3840) }]));
    },
    (log) => {
      const t = r.pick(synths());
      const n = t && r.pick(currentPattern(t).notes);
      if (t && n) (log.push('deleteNotes'), deleteNotes(p, sink, t.id, [n.id]));
    },
    // A recording pass: notes merge into one entry while it is the newest.
    (log) => {
      const t = r.pick(synths());
      if (!t) return;
      const k = 1 + r.int(6);
      log.push(`rec x${k} pass ${pass}`);
      for (let i = 0; i < k; i++) recNote(t);
    },
    (log) => (log.push('newPass'), pass++),
    // Not edits, but saved (current pattern) / snapshotted (selection).
    (log) => {
      const t = r.pick(p.tracks);
      const pat = t && r.pick<{ id: string }>(t.patterns);
      if (t && pat) (log.push('selectPattern'), selectPattern(p, sink, t.id, pat.id));
    },
    (log) => {
      const t = r.pick(p.tracks);
      if (t) (log.push('selectTrack'), selectTrack(p, sink, t.id));
    },
    (log) => {
      const t = r.pick(p.tracks);
      if (t) (log.push('newPattern'), newPattern(p, sink, t.id));
    },
    // A gesture: a drag (maybe with recorded notes landing in it).
    (log) => {
      const t = r.pick(p.tracks);
      if (!t) return;
      log.push('gesture');
      h.begin();
      for (let i = r.int(4); i >= 0; i--) {
        if (r.int(4) === 0 && synths().length) recNote(r.pick(synths())!);
        else fader(t);
      }
      h.commit();
    },
    (log) => (log.push('tempo'), setTempo(p, sink, 60 + r.int(120))),
    (log) => {
      if (p.tracks.length >= 7) return;
      log.push('addTrack');
      if (r.int(2)) addSynthTrack(p, sink);
      else addDrumTrack(p, sink);
    },
    (log) => {
      const t = r.pick(p.tracks);
      if (t && p.tracks.length > 1) (log.push('removeTrack'), removeTrack(p, sink, t.id));
    },
    (log) => {
      const t = r.pick(synths());
      const osc = t?.modules.find((x) => x.kind === moduleDef('osc').kind);
      if (t && osc) (log.push('setParam'), setParam(p, sink, t.id, osc.idx, paramIndex(moduleDef('osc'), 'octave'), r.int(5) - 2));
    },
    (log) => (log.push('undo'), h.undo()),
    (log) => (log.push('redo'), h.redo()),
  ];

  const log: string[] = [];
  let initial = start;
  for (let i = 0; i < ops; i++) {
    // The state the bottom entry's "before" holds: just before the op that made the stack non-empty.
    if (!h.canUndo) initial = serialize(p);
    menu[r.int(menu.length)](log);
    if (coalesceTask && r.int(3) === 0) await Promise.resolve(); // a later task
  }
  // End on an edit, so the newest entry's "after" is the final state (a
  // trailing pattern or track switch is not an edit: redo would not restore it).
  if (!h.canUndo) initial = serialize(p);
  setTempo(p, sink, p.tempo === 200 ? 201 : 200);
  const final = serialize(p);
  const ctx = `seed ${seed}: ${log.join(', ')}`;
  let n = 0;
  while (h.undo()) n++;
  expect(m.errors, ctx).toEqual([]);
  expect(serialize(p), ctx).toEqual(initial);
  expect(view(m, initial), ctx).toEqual(loaded(initial));
  for (let i = 0; i < n; i++) expect(h.redo(), ctx).toBe(true);
  expect(m.errors, ctx).toEqual([]);
  expect(serialize(p), ctx).toEqual(final);
  expect(view(m, final), ctx).toEqual(loaded(final));
}

describe('history property', () => {
  it('random edits round-trip', async () => {
    // SEED=n reruns one sequence (the failure message names its seed and ops).
    const only = process.env.SEED ? Number(process.env.SEED) : null;
    for (let seed = only ?? 1; seed <= (only ?? 200); seed++) await sequence(seed, 30);
  }, 60_000);
});
