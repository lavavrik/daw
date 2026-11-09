// The mixer's returns (plan 29): up to MAX_RETURNS shared effect channels,
// each a Reverb or a Delay, kept in `p.mixer.returns` in creation order.
//
//   - `slot` is the engine slot (channel MIX_RETURN0 + slot). A return keeps
//     its slot for life, and undo brings a deleted one back on the same slot,
//     so a track's send to it (catalog param send_a..send_h = slot 0..7) and
//     its colour (`--return-<slot>`, never stored) follow it.
//   - `id` is the owner string of its lanes and MIDI mappings, like a track
//     id. The two a new project starts with (and the two a pre-v7 file
//     migrates to) are 'reverb' and 'delay'; added ones get a UUID.
//   - The engine is told a slot's kind with Op.RETURN_KIND, which resets that
//     slot's params: so every builder sends it BEFORE the slot's MIX_SETs
//     (project/commands.ts mixerCommands, history/diffApply.ts).
//
// Pure helpers first, then the add / rename / delete actions (plan 29 Task 5).
// This module imports neither mixer-actions nor midiMap (both import it), so
// the delete cleans lanes and mappings by plain mutation inside its own edit.
import { MAX_RETURNS, MIX_RETURN0, Op, sendParam, sendPreParam } from '../audio/protocol';
import { defaultMixParams, mixParam } from '../audio/mixerCatalog';
import type { CommandSink } from './actions';
import { edit, markEdited } from './edits';
import type { ChannelState, Project } from './project.svelte';

export { MAX_RETURNS };

export type ReturnKind = 'reverb' | 'delay';

/** One return strip. `key` (from ChannelState) is always null: returns have no sidechain. */
export interface ReturnState extends ChannelState {
  id: string;
  kind: ReturnKind;
  /** Trimmed, 1..RETURN_NAME_MAX characters; need not be unique. */
  name: string;
  /** Engine slot 0..MAX_RETURNS-1, unique. */
  slot: number;
}

/** Longest return name. */
export const RETURN_NAME_MAX = 24;

/** Op.RETURN_KIND's b: what a slot runs. */
export const KIND_CODE: Record<ReturnKind | 'off', 0 | 1 | 2> = { off: 0, reverb: 1, delay: 2 };

/** A kind as the UI and the default names say it. */
export const KIND_NAME: Record<ReturnKind, string> = { reverb: 'Reverb', delay: 'Delay' };

/** The engine mixer channel of a return. */
export const returnChannel = (r: Pick<ReturnState, 'slot'>): number => MIX_RETURN0 + r.slot;

/** A return's colour: the theme token of its slot (ui/theme.css). */
export const returnColor = (slot: number): string => `var(--return-${slot})`;

/** A fresh return with the catalog defaults. */
export const newReturn = (id: string, kind: ReturnKind, name: string, slot: number): ReturnState =>
  ({ id, kind, name, slot, params: defaultMixParams(), key: null });

/** What a new project (and OP_RESET_ALL) starts with: Reverb on slot 0, Delay on slot 1. */
export const defaultReturns = (): ReturnState[] => [
  newReturn('reverb', 'reverb', KIND_NAME.reverb, 0),
  newReturn('delay', 'delay', KIND_NAME.delay, 1),
];

export function findReturn(p: Project, id: string): ReturnState | undefined {
  return p.mixer.returns.find((r) => r.id === id);
}

/** The slot a send level param (send_a..send_h, not a _pre flag) goes to, or null for any other param. */
export function sendSlotOf(param: string): number | null {
  for (let slot = 0; slot < MAX_RETURNS; slot++) if (sendParam(slot) === param) return slot;
  return null;
}

/** The first return of `kind` in creation order (where track presets send). */
export function firstReturnOfKind(p: Project, kind: ReturnKind): ReturnState | undefined {
  return p.mixer.returns.find((r) => r.kind === kind);
}

/** The lowest slot no return holds, or null when all MAX_RETURNS are taken. */
export function freeSlot(p: Project): number | null {
  const used = new Set(p.mixer.returns.map((r) => r.slot));
  for (let s = 0; s < MAX_RETURNS; s++) if (!used.has(s)) return s;
  return null;
}

/** "Reverb N" / "Delay N": N is the lowest integer >= 2 that no return of that kind is named with. */
export function nextReturnName(p: Project, kind: ReturnKind): string {
  const taken = new Set(p.mixer.returns.filter((r) => r.kind === kind).map((r) => r.name));
  let n = 2;
  while (taken.has(`${KIND_NAME[kind]} ${n}`)) n++;
  return `${KIND_NAME[kind]} ${n}`;
}

/**
 * Add a return of `kind` on the lowest free slot: one edit "Add return".
 * Null (no edit) when all MAX_RETURNS slots are taken. The name defaults to
 * nextReturnName; the id is a UUID. The engine gets RETURN_KIND slot 0, then
 * RETURN_KIND slot kind: a deleted return's slot is already Off, but the
 * explicit Off makes the add correct whatever the engine still holds (it
 * ignores a same-kind RETURN_KIND, and a kind change resets the slot's
 * params, which is why the new return's defaults need no MIX_SETs).
 */
export function addReturn(p: Project, sink: CommandSink, kind: ReturnKind, name?: string): ReturnState | null {
  const slot = freeSlot(p);
  if (slot === null) return null;
  return edit(p, 'Add return', () => {
    p.mixer.returns.push(newReturn(crypto.randomUUID(), kind, name ?? nextReturnName(p, kind), slot));
    sink.send(Op.RETURN_KIND, slot, KIND_CODE.off);
    sink.send(Op.RETURN_KIND, slot, KIND_CODE[kind]);
    return p.mixer.returns[p.mixer.returns.length - 1]; // the reactive proxy
  });
}

/** Rename: one edit "Rename return". False (no edit) for an unknown id or a name empty / over RETURN_NAME_MAX after trimming. */
export function renameReturn(p: Project, id: string, name: string): boolean {
  const r = findReturn(p, id);
  const n = name.trim();
  if (!r || n.length < 1 || n.length > RETURN_NAME_MAX) return false;
  return edit(p, 'Rename return', () => {
    r.name = n;
    // No engine command marks this edit, so the unsaved mark is ours.
    markEdited(p);
    return true;
  });
}

/**
 * Delete a return: one edit "Delete return". Besides the return it removes
 *   - its Master-row lanes (AUTO_LANE_CLEAR) and the MIDI mappings it owns,
 *   - every track's lane on, and MIDI mapping of, the slot's two sends
 *     (sendParam / sendPreParam), and
 *   - resets those two send params on every track to their defaults,
 * then RETURN_KIND slot 0 (Off: the engine fades the tail out over 5 ms).
 * The slot is therefore clean when a later add reuses it. Lanes go before the
 * resets so the lane's CLEAR does not undo the MIX_SET. Undo / redo are the
 * snapshot diff (history/diffApply.ts), which restores all of it.
 */
export function deleteReturn(p: Project, sink: CommandSink, id: string): boolean {
  const r = findReturn(p, id);
  if (!r) return false;
  return edit(p, 'Delete return', () => {
    const sends = new Set([sendParam(r.slot), sendPreParam(r.slot)]);
    const isSend = (t: { kind: string; param?: string }) => t.kind === 'mix' && sends.has(t.param ?? '');
    for (const x of p.mixer.automation) if (x.channel === id) sink.send(Op.AUTO_LANE_CLEAR, x.lane.lane);
    p.mixer.automation = p.mixer.automation.filter((x) => x.channel !== id);
    for (const t of p.tracks) {
      for (const l of t.automation) if (isSend(l.target)) sink.send(Op.AUTO_LANE_CLEAR, l.lane);
      if (t.automation.some((l) => isSend(l.target))) t.automation = t.automation.filter((l) => !isSend(l.target));
    }
    for (const t of p.tracks) {
      const ch = p.mixer.channels[t.id];
      if (!ch) continue;
      for (const name of sends) {
        const def = mixParam(name);
        if (ch.params[def.id] === def.default) continue;
        ch.params[def.id] = def.default;
        sink.send(Op.MIX_SET, t.slot, def.id, def.default);
      }
    }
    const gone = p.midiMap.filter((m) => m.owner === id || isSend(m.target));
    if (gone.length) p.midiMap = p.midiMap.filter((m) => !gone.includes(m));
    p.mixer.returns = p.mixer.returns.filter((x) => x.id !== id);
    sink.send(Op.RETURN_KIND, r.slot, KIND_CODE.off);
    return true;
  });
}
