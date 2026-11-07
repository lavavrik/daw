// Mixer edits. Like actions.ts: mutate Project.mixer AND send the matching
// engine command. Channel index on the wire: the track's slot, or
// MIX_REVERB / MIX_DELAY / MIX_MASTER for the shared channels.
import { MIX_DELAY, MIX_MASTER, MIX_REVERB, Op, keyCode } from '../audio/protocol';
import { MIX_PARAMS, clampMix, mixParam } from '../audio/mixerCatalog';
import type { MixTarget } from '../audio/mixerCatalog';
import type { CommandSink } from './actions';
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

/** Clamp to the catalog range (integers rounded, NaN -> default) and send MIX_SET. */
export function setMix(p: Project, sink: CommandSink, target: MixChannelTarget, param: string, value: number) {
  const r = resolve(p, target);
  const def = MIX_PARAMS.find((d) => d.name === param);
  // The engine rejects params that do not apply to the channel kind; so do we.
  if (!r || !def || !def.appliesTo.includes(r.kind)) return;
  const v = clampMix(def, value);
  r.ch.params[def.id] = v;
  sink.send(Op.MIX_SET, r.index, def.id, v);
}

const flag = (p: Project, target: MixChannelTarget, name: string): number | null => {
  const r = resolve(p, target);
  return r ? r.ch.params[mixParam(name).id] : null;
};

export function toggleSolo(p: Project, sink: CommandSink, trackId: string) {
  const cur = flag(p, trackId, 'solo');
  if (cur !== null) setMix(p, sink, trackId, 'solo', cur ? 0 : 1);
}

/** Tracks and the two returns. */
export function toggleMute(p: Project, sink: CommandSink, target: MixChannelTarget) {
  const cur = flag(p, target, 'mute');
  if (cur !== null) setMix(p, sink, target, 'mute', cur ? 0 : 1);
}

/**
 * Set a track's compressor key: another track, a drum row, or null (own
 * signal). A key at the channel's own whole track means none, so it is stored
 * and sent as none. Invalid keys (unknown track, row out of range, row of a
 * synth track) are ignored.
 */
export function setSidechain(p: Project, sink: CommandSink, trackId: string, key: SidechainKey | null) {
  const t = p.tracks.find((x) => x.id === trackId);
  const ch = p.mixer.channels[trackId];
  if (!t || !ch) return;
  let stored: SidechainKey | null = null;
  let code = -1;
  if (key) {
    const src = p.tracks.find((x) => x.id === key.trackId);
    if (!src) return;
    if (key.row === null) {
      if (src.id !== trackId) {
        stored = { trackId: src.id, row: null };
        code = keyCode({ slot: src.slot });
      }
    } else {
      if (src.kind !== 'drum' || !Number.isInteger(key.row) || key.row < 0 || key.row >= src.rows.length) return;
      stored = { trackId: src.id, row: key.row };
      code = keyCode({ slot: src.slot, row: key.row });
    }
  }
  ch.key = stored;
  sink.send(Op.MIX_SET_KEY, t.slot, code);
}

/** "Drums · kick", "Synth", or "none". */
export function keyLabel(p: Project, key: SidechainKey | null): string {
  const t = key ? p.tracks.find((x) => x.id === key.trackId) : null;
  if (!key || !t) return 'none';
  if (key.row === null) return t.name;
  const row = t.kind === 'drum' ? t.rows[key.row] : undefined;
  return `${t.name} · ${row ? row.name : `Row ${key.row + 1}`}`;
}
