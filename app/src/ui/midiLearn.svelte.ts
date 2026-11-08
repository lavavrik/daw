// MIDI learn from the control (plan 14 Task 3; docs/architecture/midi.md "UI").
//
// Learn mode: "MIDI learn" in a knob's or fader's right-click menu
// (AutoMenu.svelte) calls startLearn(owner, target, label). The control then
// pulses (Knob / Fader read isLearning) and the header hint says LEARN_HINT.
// The first LEARNABLE CC that arrives binds to it (state/midiMap.ts
// learnMidi: one undo entry "MIDI learn CC <n>") and ends learn mode with a
// flash "MIDI CC <n> → <label>". That CC only binds: it does not also move
// the control, so the learn entry stays a pure learn. A non-learnable CC
// (120..127; parseMidi never even emits 120/123) is ignored and learning
// goes on. Esc (App), a second "MIDI learn" (it replaces the target: one
// learn target at a time) or LEARN_TIMEOUT_MS without a learnable CC
// cancels. If the control vanished meanwhile (its track was removed), the
// CC binds nothing and learn mode just ends.
//
// Playing a mapping (createCcRouter): outside learn mode every CC is
// recorded as the latest value of its CC number, and ONE requestAnimationFrame
// applies each waiting CC once (state/midiMap.ts applyCc: setParam / setMix,
// then `touch`, which App wires to autoBus.touch so an automated target is
// overridden in Song mode exactly like a knob drag). So a 1 kHz CC stream
// costs one edit per mapping per frame.
//
// Undo: a sweep is one entry. Its coalesce key is `midi:<cc>:<n>`; `n`
// steps when a CC arrives more than SWEEP_GAP_MS after the previous one on
// that CC, so two sweeps of the same knob a few seconds apart are two
// entries. App's history also merges one-shot edits made in the same task
// (coalesceTask): CCs on DIFFERENT mappings applied in the same frame (one
// rAF callback) may merge into one entry (accepted). A learn happens in the
// MIDI message's task and a move only ever in a later rAF, so a learn and a
// move never merge.
import { banners, flashHint } from '../state/banners.svelte';
import type { CommandSink } from '../state/actions';
import { sameTarget } from '../state/automation';
import { LEARNABLE_CC, applyCc, learnMidi, learnableDef, mappingDef, mappingForCc } from '../state/midiMap';
import type { MixChannelTarget } from '../state/mixer-actions';
import type { AutoTarget, Project } from '../state/project.svelte';

/** The hint shown while learning (spec text, verbatim). */
export const LEARN_HINT = 'Move a knob on your MIDI controller (Esc cancels)';
/** Learn mode ends after this long without a learnable CC. */
export const LEARN_TIMEOUT_MS = 10_000;
/** A CC this long after the previous one on its number starts a new sweep (a new undo entry). */
export const SWEEP_GAP_MS = 1000;

export interface LearnTarget {
  owner: MixChannelTarget;
  target: AutoTarget;
  /** The control's accessible name ("Filter Cutoff"), for the flash after learning. */
  label: string;
}

const state = $state<{ learn: LearnTarget | null }>({ learn: null });
let timer: ReturnType<typeof setTimeout> | undefined;

/** The control being learned, or null (reactive). */
export const learning = (): LearnTarget | null => state.learn;

/** Is this control the one being learned? (reactive: Knob / Fader's pulsing ring) */
export const isLearning = (owner: MixChannelTarget, target: AutoTarget): boolean =>
  state.learn !== null && state.learn.owner === owner && sameTarget(state.learn.target, target);

/** Enter learn mode for this control (replacing any other learn target) and restart the timeout. */
export function startLearn(owner: MixChannelTarget, target: AutoTarget, label: string) {
  clearTimeout(timer);
  state.learn = { owner, target, label };
  banners.hint = LEARN_HINT;
  timer = setTimeout(cancelLearn, LEARN_TIMEOUT_MS);
}

/** Leave learn mode (Esc, the timeout); the hint goes unless something replaced it. */
export function cancelLearn() {
  clearTimeout(timer);
  timer = undefined;
  state.learn = null;
  if (banners.hint === LEARN_HINT) banners.hint = null;
}

/**
 * Does this control offer "MIDI learn"? It must exist (mappingDef) and be
 * continuous or integer, not a choice or a 0..1 on/off flag (learnableDef).
 */
export function canLearn(p: Project, owner: MixChannelTarget, target: AutoTarget): boolean {
  const def = mappingDef(p, owner, target);
  return def !== null && learnableDef(def);
}

export interface CcRouterDeps {
  p: Project;
  sink: CommandSink;
  /** A manual move of (owner, target) is being sent: App's autoBus.touch (AUTO_OVERRIDE in Song mode). */
  touch: (owner: MixChannelTarget, target: AutoTarget) => void;
  raf?: (cb: () => void) => unknown;
  /** Clock for sweep boundaries (ms). */
  now?: () => number;
}

/** App routes every CC (input/midi.ts onCc) here: learn mode, else a per-frame batch of moves. */
export function createCcRouter(d: CcRouterDeps): { onCc(cc: number, v: number): void } {
  const raf = d.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const now = d.now ?? (() => performance.now());
  /** cc -> its latest value, waiting for the frame (Map: insertion order = arrival order). */
  const pending = new Map<number, number>();
  /** cc -> its current sweep number and when its last CC arrived. */
  const sweeps = new Map<number, { n: number; at: number }>();
  let scheduled = false;

  function frame() {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    for (const [cc, v] of batch) applyCc(d.p, d.sink, cc, v, d.touch, `midi:${cc}:${sweeps.get(cc)?.n ?? 0}`);
  }

  return {
    onCc(cc, v) {
      const l = state.learn;
      if (l) {
        if (!LEARNABLE_CC(cc)) return; // not learnable: keep learning
        cancelLearn();
        pending.delete(cc); // a value queued for the CC's OLD control must not land after the learn
        if (learnMidi(d.p, cc, l.owner, l.target)) flashHint(`MIDI CC ${cc} → ${l.label}`);
        return;
      }
      const t = now();
      const s = sweeps.get(cc);
      if (!s) sweeps.set(cc, { n: 1, at: t });
      else {
        if (t - s.at > SWEEP_GAP_MS) s.n++;
        s.at = t;
      }
      if (!mappingForCc(d.p, cc)) return; // unmapped: no frame for it (a controller streams CCs)
      pending.set(cc, v);
      if (!scheduled) {
        scheduled = true;
        raf(frame);
      }
    },
  };
}
