// Cost of the undo history on a big project (docs/architecture/history.md,
// "Cost"). Not a regression test: skipped unless MEASURE=1, it prints the
// numbers the doc quotes. Heap numbers need --expose-gc:
//   MEASURE=1 npx vitest run src/history/history.measure.test.ts \
//     --pool=forks --execArgv=--expose-gc
import { describe, it } from 'vitest';
import { addDrumTrack, toggleStep } from '../state/actions';
import { setMix } from '../state/mixer-actions';
import { addNote } from '../state/pattern-actions';
import { addSynthTrack } from '../state/rack-actions';
import { edit } from '../state/edits';
import { Project } from '../state/project.svelte';
import type { SynthTrack } from '../state/project.svelte';
import { serialize } from '../project/serialize';
import { createHistory } from './history';
import { diffApply } from './diffApply';

const sink = { send: () => true };

/** 16 drum tracks (a busy pattern each) + 16 synth tracks (200 notes each): 32 tracks. */
function bigProject() {
  const p = new Project();
  for (let i = 0; i < 16; i++) {
    const d = addDrumTrack(p, sink)!;
    for (let s = 0; s < 16; s += 2) toggleStep(p, sink, d.id, d.rows[s % d.rows.length].id, s);
  }
  for (let i = 0; i < 16; i++) {
    const t = addSynthTrack(p, sink)!;
    for (let n = 0; n < 200; n++) addNote(p, sink, t.id, { pitch: 36 + (n % 48), start: n * 37, len: 30 });
  }
  return p;
}

function install(p: Project) {
  const stats = { snapshots: 0, ms: 0 };
  const h = createHistory({
    snapshot: () => {
      const t = performance.now();
      stats.snapshots++;
      const s = serialize(p);
      stats.ms += performance.now() - t;
      return s;
    },
    apply: (from, to) => diffApply(p, sink, from, to),
  });
  p.history = h;
  return { h, stats };
}

const gc = (globalThis as { gc?: () => void }).gc;
const heap = () => {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
};

describe.skipIf(!process.env.MEASURE)('history cost (MEASURE=1)', () => {
  it('recording 500 notes, then undo', () => {
    const p = bigProject();
    const { h, stats } = install(p);
    const t = p.tracks.find((x): x is SynthTrack => x.kind === 'synth')!;
    const t0 = performance.now();
    for (let n = 0; n < 500; n++) {
      edit(p, 'Record', () => addNote(p, sink, t.id, { pitch: 60 + (n % 12), start: 7 + n * 13, len: 10 }), { coalesce: 'rec:1' });
    }
    const total = performance.now() - t0;
    const recSnaps = stats.snapshots;
    const u0 = performance.now();
    h.undo();
    const undoMs = performance.now() - u0;
    console.log(
      `[measure] record 500 notes: snapshots=${recSnaps} (${(recSnaps / 500).toFixed(3)}/note), ` +
      `serialize ${stats.ms.toFixed(1)} ms, total ${total.toFixed(1)} ms (${(total / 500).toFixed(3)} ms/note); ` +
      `undo ${undoMs.toFixed(1)} ms; json ${JSON.stringify(serialize(p)).length} B`,
    );
  });

  it('memory per entry (100 one-track edits)', () => {
    const p = bigProject();
    const { h } = install(p);
    const fader = (i: number) => -1 - (i % 40);
    setMix(p, sink, p.tracks[0].id, 'fader', -0.5); // first entry (its snapshots are the baseline)
    const base = heap();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) setMix(p, sink, p.tracks[i % 32].id, 'fader', fader(i));
    const ms = (performance.now() - t0) / 100;
    const per = (heap() - base) / 100;
    console.log(`[measure] one-shot edit ${ms.toFixed(2)} ms; heap per entry: ${(per / 1024).toFixed(1)} KiB (gc: ${gc ? 'yes' : 'NO, numbers are noisy'}); undo ok: ${h.undo()}`);
  });
});
