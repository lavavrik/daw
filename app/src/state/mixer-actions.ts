// Mixer edits. Like actions.ts: mutate Project.mixer AND send the matching
// engine command. Channel index on the wire: the track's slot, or
// MIX_REVERB / MIX_DELAY / MIX_MASTER for the shared channels.
import { MAX_KEYS, MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, keyCode } from '../audio/protocol';
import { clampParam } from '../audio/catalog';
import { MIX_PARAMS, mixParam } from '../audio/mixerCatalog';
import type { MixParamDef, MixTarget } from '../audio/mixerCatalog';
import type { CommandSink } from './actions';
import { edit } from './edits';
import { flashHint } from './banners.svelte';
import { rowHasRole } from './kits';
import type { ChannelState, Project, SidechainKey } from './project.svelte';

export type MixChannelTarget = string /* trackId */ | 'reverb' | 'delay' | 'master';

interface Resolved {
  ch: ChannelState;
  index: number;
  kind: MixTarget;
}

function resolve(p: Project, target: MixChannelTarget): Resolved | null {
  switch (target) {
    case 'reverb': return { ch: p.mixer.reverb, index: MIX_REVERB, kind: 'return' };
    case 'delay': return { ch: p.mixer.delay, index: MIX_DELAY, kind: 'return' };
    case 'master': return { ch: p.mixer.master, index: MIX_MASTER, kind: 'master' };
  }
  const t = p.tracks.find((x) => x.id === target);
  const ch = p.mixer.channels[target];
  return t && ch ? { ch, index: t.slot, kind: 'track' } : null;
}

/**
 * Does channel `index` (of kind `kind`) take `def`? Mirrors the engine's
 * MixParam::accepts (engine/src/mixer/catalog.rs): reverb-group params only
 * on the Reverb return, delay-group params only on the Delay return (both are
 * 'return' channels), everything else by `appliesTo`. Also the rule for
 * mixer params in a project file (project/schema.ts).
 */
export function accepts(def: MixParamDef, kind: MixTarget, index: number): boolean {
  if (def.group === 'reverb') return index === MIX_REVERB;
  if (def.group === 'delay') return index === MIX_DELAY;
  return def.appliesTo.includes(kind);
}

/**
 * Clamp to the catalog range (integers rounded, NaN -> default) and send
 * MIX_SET. `opts` as rack-actions setParam's (a MIDI CC move: its own undo
 * label and coalesce key).
 */
export function setMix(
  p: Project, sink: CommandSink, target: MixChannelTarget, param: string, value: number,
  opts?: { coalesce?: string; label?: string },
) {
  return edit(p, opts?.label ?? `Set ${MIX_PARAMS.find((d) => d.name === param)?.label ?? param}`, () => {
    const r = resolve(p, target);
    const def = MIX_PARAMS.find((d) => d.name === param);
    // The engine rejects params the channel does not take; so do we (nothing
    // stored, nothing sent).
    if (!r || !def || !accepts(def, r.kind, r.index)) return;
    const v = clampParam(def, value);
    r.ch.params[def.id] = v;
    sink.send(Op.MIX_SET, r.index, def.id, v);
  }, opts?.coalesce !== undefined ? { coalesce: opts.coalesce } : undefined);
}

const flag = (p: Project, target: MixChannelTarget, name: string): number | null => {
  const r = resolve(p, target);
  return r ? r.ch.params[mixParam(name).id] : null;
};

/**
 * The S button of a track (track header or mixer strip). Exclusive by default
 * (owner's note, plan 20 task 12): S on a track that is not soloed solos it
 * and unsolos every other track; S on a soloed track unsolos just that one
 * (the others are unchanged). `additive` (Cmd/Ctrl/Shift-click) is the old
 * toggle of that one track, to build a multi-track solo. One undo entry,
 * "Solo <name>" / "Unsolo <name>". Only tracks have a solo (the returns and
 * the master have none).
 */
export function toggleSolo(p: Project, sink: CommandSink, trackId: string, o: { additive?: boolean } = {}) {
  const t = p.tracks.find((x) => x.id === trackId);
  const cur = flag(p, trackId, 'solo');
  const label = t ? `${cur ? 'Unsolo' : 'Solo'} ${t.name}` : 'Solo';
  return edit(p, label, () => {
    if (!t || cur === null) return;
    setMix(p, sink, trackId, 'solo', cur ? 0 : 1);
    if (cur || o.additive) return;
    for (const other of p.tracks) {
      if (other.id !== trackId && flag(p, other.id, 'solo')) setMix(p, sink, other.id, 'solo', 0);
    }
  });
}

/** Tracks and the two returns. */
export function toggleMute(p: Project, sink: CommandSink, target: MixChannelTarget) {
  return edit(p, 'Mute', () => {
    const cur = flag(p, target, 'mute');
    if (cur !== null) setMix(p, sink, target, 'mute', cur ? 0 : 1);
  });
}

/**
 * Whether `trackId`'s compressor may use `key`. Only drum rows are limited:
 * the engine has MAX_KEYS key slots, one per distinct (drum track, row) keyed
 * by any strip, and rejects (BAD_VALUE) a key that would need one more. Same
 * rule as the engine's Mixer::set_key: count the distinct rows keyed by the
 * *other* channels; the key is allowed if that count is below MAX_KEYS or the
 * row is already among them (shared). The channel's own current row does not
 * count, since re-keying frees it.
 */
export function rowKeyAllowed(p: Project, trackId: string, key: SidechainKey | null): boolean {
  if (!key || key.row === null) return true;
  const rows = new Set<string>();
  for (const [id, ch] of Object.entries(p.mixer.channels)) {
    if (id !== trackId && ch.key && ch.key.row !== null) rows.add(`${ch.key.trackId}:${ch.key.row}`);
  }
  return rows.size < MAX_KEYS || rows.has(`${key.trackId}:${key.row}`);
}

/**
 * Set a track's compressor key: another track, a drum row, or null (own
 * signal). A key at the channel's own whole track means none, so it is stored
 * and sent as none. Invalid keys (unknown track, row out of range, row of a
 * synth track) and a row that would be a (MAX_KEYS+1)th distinct row key
 * (rowKeyAllowed) are refused: nothing changes, nothing is sent, false.
 */
export function setSidechain(p: Project, sink: CommandSink, trackId: string, key: SidechainKey | null): boolean {
  return edit(p, 'Sidechain', () => {
    const t = p.tracks.find((x) => x.id === trackId);
    const ch = p.mixer.channels[trackId];
    if (!t || !ch) return false;
    let stored: SidechainKey | null = null;
    let code = -1;
    if (key) {
      const src = p.tracks.find((x) => x.id === key.trackId);
      if (!src) return false;
      if (key.row === null) {
        if (src.id !== trackId) {
          stored = { trackId: src.id, row: null };
          code = keyCode({ slot: src.slot });
        }
      } else {
        if (src.kind !== 'drum' || !Number.isInteger(key.row) || key.row < 0 || key.row >= src.rows.length) return false;
        if (!rowKeyAllowed(p, trackId, key)) return false;
        stored = { trackId: src.id, row: key.row };
        code = keyCode({ slot: src.slot, row: key.row });
      }
    }
    ch.key = stored;
    sink.send(Op.MIX_SET_KEY, t.slot, code);
    return true;
  });
}

/** "Drums · kick", "Synth", or "none". */
export function keyLabel(p: Project, key: SidechainKey | null): string {
  const t = key ? p.tracks.find((x) => x.id === key.trackId) : null;
  if (!key || !t) return 'none';
  if (key.row === null) return t.name;
  const row = t.kind === 'drum' ? t.rows[key.row] : undefined;
  return `${t.name} · ${row ? row.name : `Row ${key.row + 1}`}`;
}

/**
 * Duck to kick's compressor (plan 27, spec 2026-11-19-builtin-content.md §3,
 * retuned by the plan 27 final review; docs/architecture/mixer.md "Duck to
 * kick"): the classic house pump, about 7-10 dB on each kick.
 *
 * What the comp really hears: a kit kick normalised to -1 dBFS, played by
 * its row at default gain and centre pan (equal-power: -3 dB per channel)
 * and at step velocity 120 ("X") or 100 ("x"), keys it at about -4.5 or
 * -6.1 dBFS. Against that:
 *   - threshold -14 dB, ratio 8: (key - threshold) * 7/8 = about 8 dB of
 *     reduction on an accented kick, 7 dB on a plain one; the high ratio
 *     makes the dip follow the kick's own envelope (deep on the hit, gone as
 *     the body decays);
 *   - attack 1 ms: the dip lands with the kick's first cycle;
 *   - release 100 ms: back within a dB before the next beat (469-500 ms at
 *     120-128 bpm) on every shipped kit but Deep's 750 ms kick;
 *   - makeup 0: a ducker is a dip, not a level change (with makeup the strip
 *     would jump louder whenever the kick stops).
 * The spec's first values (-30 dB, 8:1, 1 ms, 150 ms, +2 dB: DUCK_TO_KICK_V1)
 * ducked 20-24 dB and never recovered between kicks.
 */
export const DUCK_TO_KICK = {
  comp_on: 1, comp_threshold: -14, comp_ratio: 8, comp_attack: 1, comp_release: 100, comp_makeup: 0,
} as const;

/** Duck to kick before the plan 27 final review: projects saved then still hold it (hasDuckComp). */
export const DUCK_TO_KICK_V1 = {
  comp_on: 1, comp_threshold: -30, comp_ratio: 8, comp_attack: 1, comp_release: 150, comp_makeup: 2,
} as const;

/**
 * The sidechain key Duck to kick uses: the Kick row (by role, kits.ts
 * rowHasRole: "Kick", " kick " ...; its first such row) of the first drum
 * track, in track order, that has one. Null when no drum track has a Kick.
 * (The spec says "the first drum track's Kick row"; a first drum track with
 * no Kick, say a percussion track, is skipped rather than refused.)
 */
export function kickKey(p: Project): { trackId: string; row: number } | null {
  for (const t of p.tracks) {
    if (t.kind !== 'drum') continue;
    const row = t.rows.findIndex((r) => rowHasRole(r.name, 'Kick'));
    if (row >= 0) return { trackId: t.id, row };
  }
  return null;
}

export type DuckResult = { ok: true } | { ok: false; reason: string };

/**
 * Presets ▸ Duck to kick on a track strip: key the track's compressor from
 * the Kick row (kickKey) and set DUCK_TO_KICK, as ONE undo entry "Duck to
 * kick" (setSidechain and setMix nested in one edit). Leaves fader, pan,
 * EQ and sends alone.
 *
 * Refused, with nothing changed or sent and a reason for the status line
 * (the caller shows it: Strip flashHint), when:
 *   - `trackId` is not a track (the returns and the master have no comp);
 *   - no drum track has a Kick row;
 *   - `trackId` is the drum track that owns that Kick (keying the kit from
 *     its own kick would duck the kick itself);
 *   - the Kick row would be a (MAX_KEYS+1)th distinct drum-row key
 *     (rowKeyAllowed; a Kick row another strip already keys is shared, so
 *     it is always allowed).
 *
 * Template builds (plan 27 Task 2) call this directly: `edit` makes no undo
 * entry when the project has no history yet, while it is loading, or while
 * it is baselining (state/edits.ts), and inside an outer edit it is part of
 * that one entry.
 */
export function duckToKick(p: Project, sink: CommandSink, trackId: string): DuckResult {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t || !p.mixer.channels[trackId]) return { ok: false, reason: 'Duck to kick works on track strips only' };
  const key = kickKey(p);
  if (!key) return { ok: false, reason: 'Duck to kick: no Kick row in any drum track' };
  if (key.trackId === trackId) return { ok: false, reason: 'Duck to kick: this is the track that plays the Kick' };
  if (!rowKeyAllowed(p, trackId, key)) {
    return { ok: false, reason: `Duck to kick: already ${MAX_KEYS} drum-row sidechain keys (the most); free one first` };
  }
  return edit(p, 'Duck to kick', () => {
    setSidechain(p, sink, trackId, key);
    for (const [name, v] of Object.entries(DUCK_TO_KICK)) setMix(p, sink, trackId, name, v);
    return { ok: true } as const;
  });
}

/**
 * Does this channel's comp hold exactly Duck to kick's settings, today's or
 * the ones it had before the retune (DUCK_TO_KICK_V1: a project saved then
 * still unducks when it loses its kick)?
 */
export function hasDuckComp(ch: ChannelState): boolean {
  const is = (values: Record<string, number>) => Object.entries(values).every(([name, v]) => ch.params[mixParam(name).id] === v);
  return is(DUCK_TO_KICK) || is(DUCK_TO_KICK_V1);
}

/**
 * Before a drum row or a track is deleted: the channels whose sidechain key
 * that deletion clears (keyed to `trackId`, to its row `row` when given),
 * each with what is going ("kick" when the key was a Kick row). Hand the
 * result to unduckLostKeys after the deletion (state/actions.ts
 * removeDrumRow, removeTrack).
 */
export function keysLostBy(p: Project, trackId: string, row?: number): { channelId: string; what: string }[] {
  const src = p.tracks.find((t) => t.id === trackId);
  const lost: { channelId: string; what: string }[] = [];
  for (const [channelId, ch] of Object.entries(p.mixer.channels)) {
    const k = ch.key;
    if (!k || k.trackId !== trackId || channelId === trackId) continue;
    if (row !== undefined && k.row !== row) continue;
    const rowName = src?.kind === 'drum' && k.row !== null ? src.rows[k.row]?.name : undefined;
    lost.push({ channelId, what: rowName !== undefined && rowHasRole(rowName, 'Kick') ? 'kick' : (rowName ?? src?.name ?? 'key') });
  }
  return lost;
}

/**
 * Duck to kick without its kick (plan 27 Task 1 review, ruling 6): when a
 * deletion clears a strip's key, a comp still set to Duck to kick (hasDuckComp:
 * −14 dB, 8:1, 1 ms; or the old −30 dB values) would now listen to the strip
 * itself and squash its loud parts (a bass peaking near −6 dBFS by a few dB at
 * −14, by 15-20 dB at the old −30). So, in the deleting edit, each such
 * strip's comp is switched off
 * (comp_on 0 only: the other comp values stay, so turning it back on and
 * re-keying restores the duck), and the status line says so: "Duck to kick
 * removed from Bass (kick deleted)". A strip whose comp the user changed
 * since is left alone: its settings are their own.
 */
export function unduckLostKeys(p: Project, sink: CommandSink, lost: { channelId: string; what: string }[]) {
  const names: string[] = [];
  const whats = new Set<string>();
  for (const { channelId, what } of lost) {
    const ch = p.mixer.channels[channelId];
    const t = p.tracks.find((x) => x.id === channelId);
    if (!ch || !t || ch.key || !hasDuckComp(ch)) continue;
    setMix(p, sink, channelId, 'comp_on', 0);
    names.push(t.name);
    whats.add(what);
  }
  if (names.length) flashHint(`Duck to kick removed from ${names.join(', ')} (${[...whats].join(', ')} deleted)`);
}

/**
 * The strip's Sidechain select (ui/mixer/Strip.svelte): setSidechain as the
 * user's own pick, one "Sidechain" undo entry. Picking "none" on a strip that
 * is ducked (keyed, its comp at Duck to kick's values: hasDuckComp) also
 * switches its comp off in the same edit, so it doesn't squash itself; the
 * same rule as deleting the kick (unduckLostKeys, plan 27 final review). Undo
 * and other callers use setSidechain itself, which never touches the comp.
 * False (nothing changed) when setSidechain refuses.
 */
export function pickSidechain(p: Project, sink: CommandSink, trackId: string, key: SidechainKey | null): boolean {
  return edit(p, 'Sidechain', () => {
    const ch = p.mixer.channels[trackId];
    const ducked = !!ch?.key && hasDuckComp(ch);
    if (!setSidechain(p, sink, trackId, key)) return false;
    if (key === null && ducked) {
      setMix(p, sink, trackId, 'comp_on', 0); // only switched off, as unduckLostKeys
      flashHint(`Duck to kick removed from ${p.tracks.find((t) => t.id === trackId)?.name ?? 'this strip'} (sidechain set to none)`);
    }
    return true;
  });
}
