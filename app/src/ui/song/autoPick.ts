// The automation picker's model (plan 21 §9; AutoPicker.svelte draws it),
// pure and unit-tested (autoPick.test.ts).
//
//   ownerGroups / rowGroups   what a lane-row owner can automate, as a
//                             two-level list: groups, each with its params.
//   filterGroups              the search: across groups, case-insensitive.
//   pickerRows                the visible rows (headers + expanded params).
//   bestMatch                 which row a search makes active.
//
// GROUPS. A track: its mixer params split into Volume / Pan / Sends / EQ /
// Comp (section "Mixer"), then (synth tracks) one group per rack module in
// rack order, named by its rack title ("Filter", "Oscillator 2": autoLabels
// moduleTitles; section "Rack"). The Master row: one group per channel
// (Master, Reverb, Delay), each holding that channel's mixer params. The
// targets are automatableParams' (state/automation.ts: continuous params
// only, no Scope), so the picker never offers what the engine refuses. A
// target that already has a lane stays listed, marked `used` (the picker
// shows it disabled, "already automated"), so the list does not reshuffle
// as lanes come and go.
import { moduleDef } from '../../audio/catalog';
import type { MixParamDef } from '../../audio/mixerCatalog';
import { automatableParams, sameTarget } from '../../state/automation';
import type { AutoOwner } from '../../state/automation';
import type { AutoTarget, MasterChannel, Project } from '../../state/project.svelte';
import { channelName, mixLabel, moduleTitles, targetLabel } from './autoLabels';
import { MASTER_ROW } from './tlMath';

export interface PickItem {
  /** Who gets the lane: a track id, or a Master row channel. */
  owner: string;
  target: AutoTarget;
  /** The param's name inside its group ("Cutoff", "Low cut"). */
  label: string;
  /** What the lane header will say ("Filter · Cutoff", "EQ Low cut"): searched too. */
  lane: string;
  /** It already has a lane: listed, not pickable. */
  used: boolean;
}

export interface PickGroup {
  /** Stable within a row: `<owner>:mix:<group>` or `<owner>:rack:<module idx>`. */
  key: string;
  name: string;
  /** "Mixer" or "Rack" on a track; null on the Master row (the group is the channel). */
  section: string | null;
  items: PickItem[];
}

/** A track mixer's groups, in this order (spec §9); the catalog's `fader` group holds both Volume and Pan. */
const MIX_GROUPS: { id: string; name: string; has: (d: MixParamDef) => boolean }[] = [
  { id: 'volume', name: 'Volume', has: (d) => d.name === 'fader' },
  { id: 'pan', name: 'Pan', has: (d) => d.name === 'pan' },
  { id: 'send', name: 'Sends', has: (d) => d.group === 'send' },
  { id: 'eq', name: 'EQ', has: (d) => d.group === 'eq' },
  { id: 'comp', name: 'Comp', has: (d) => d.group === 'comp' },
];

/** The Master row's channels: the master, then the returns in creation order. */
const channels = (p: Project): MasterChannel[] => ['master', ...p.mixer.returns.map((r) => r.id)];

/** The groups of one owner of `p` (`ownerId`: its track id or channel), `used` = targets that have a lane. */
export function ownerGroups(p: Project, owner: AutoOwner, ownerId: string, used: readonly AutoTarget[]): PickGroup[] {
  const item = (target: AutoTarget, label: string): PickItem => ({
    owner: ownerId,
    target,
    label,
    lane: targetLabel(p, owner, target),
    used: used.some((u) => sameTarget(u, target)),
  });
  const all = automatableParams(p, owner);
  const mix = all.filter((x) => x.target.kind === 'mix');
  if (typeof owner === 'string') {
    // A Master row channel: one group, its params by what the lane calls
    // them minus the channel ("Ceiling", "EQ Low cut"); the fader is "Volume".
    const items = mix.map((x) => item(x.target, x.target.param === 'fader' ? 'Volume' : mixLabel(x.def as MixParamDef)));
    return [{ key: `${ownerId}:mix`, name: channelName(p, owner), section: null, items }];
  }
  const out: PickGroup[] = [];
  for (const g of MIX_GROUPS) {
    const items = mix.filter((x) => g.has(x.def as MixParamDef)).map((x) => item(x.target, x.def.label));
    if (items.length) out.push({ key: `${ownerId}:mix:${g.id}`, name: g.name, section: 'Mixer', items });
  }
  if (owner.kind === 'synth') {
    const titles = moduleTitles(owner.modules);
    const byModule = new Map<number, PickItem[]>();
    for (const x of all) {
      if (x.target.kind !== 'rack') continue;
      const list = byModule.get(x.target.module) ?? [];
      list.push(item(x.target, x.def.label));
      byModule.set(x.target.module, list); // automatableParams walks the rack in order: so does the Map
    }
    for (const [m, items] of byModule) {
      const kind = owner.modules.find((x) => x.idx === m)?.kind;
      const name = titles.get(m) ?? (kind === undefined ? '?' : moduleDef(kind).name);
      out.push({ key: `${ownerId}:rack:${m}`, name, section: 'Rack', items });
    }
  }
  return out;
}

/** The groups of a timeline row's owner: a track's (by id), or the Master row's channels (master, returns). */
export function rowGroups(p: Project, rowId: string): PickGroup[] {
  if (rowId === MASTER_ROW) {
    return channels(p).flatMap((c) =>
      ownerGroups(
        p,
        c,
        c,
        p.mixer.automation.filter((x) => x.channel === c).map((x) => x.lane.target),
      ),
    );
  }
  const t = p.tracks.find((x) => x.id === rowId);
  return t ? ownerGroups(p, t, t.id, t.automation.map((l) => l.target)) : [];
}

const norm = (q: string) => q.trim().toLowerCase();

/**
 * The search. An empty query keeps everything. Otherwise a group whose name
 * (or section: "mix" finds the mixer) contains the query keeps all its
 * params; any other group keeps the params whose name or lane label
 * contains it, and goes when none does.
 */
export function filterGroups(groups: readonly PickGroup[], query: string): PickGroup[] {
  const q = norm(query);
  if (!q) return [...groups];
  const out: PickGroup[] = [];
  for (const g of groups) {
    if (`${g.section ?? ''} ${g.name}`.toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const items = g.items.filter((x) => x.label.toLowerCase().includes(q) || x.lane.toLowerCase().includes(q));
    if (items.length) out.push({ ...g, items });
  }
  return out;
}

export type PickRow = { kind: 'group'; group: PickGroup } | { kind: 'item'; group: PickGroup; item: PickItem };

/** The rows on screen: each group's header, then its params when `expanded` has its key. */
export function pickerRows(groups: readonly PickGroup[], expanded: ReadonlySet<string>): PickRow[] {
  const out: PickRow[] = [];
  for (const g of groups) {
    out.push({ kind: 'group', group: g });
    if (expanded.has(g.key)) for (const item of g.items) out.push({ kind: 'item', group: g, item });
  }
  return out;
}

/**
 * The row a search makes active, so Enter picks the likeliest param. Three
 * tiers, best first: the name starts with the query ("cut": Cutoff, not EQ
 * Low cut), a word of it does, it contains it. At each tier a param's own
 * name is tried first, then a group's name: a group-name match ("filter",
 * "env" → Envelope) makes that group's first pickable param active, ahead of
 * a weaker match in some param's name ("Filter › Mod env" only has a
 * word starting with "env"). Failing all, the first pickable param on
 * screen; failing that, the first row. -1 when there are no rows.
 */
export function bestMatch(rows: readonly PickRow[], query: string): number {
  const q = norm(query);
  if (!rows.length) return -1;
  if (!q) return 0;
  const tests: ((label: string) => boolean)[] = [
    (l) => l.startsWith(q),
    (l) => l.split(/\s+/).some((w) => w.startsWith(q)),
    (l) => l.includes(q),
  ];
  const pickable = (r: PickRow) => r.kind === 'item' && !r.item.used;
  for (const test of tests) {
    const i = rows.findIndex((r) => pickable(r) && r.kind === 'item' && test(r.item.label.toLowerCase()));
    if (i >= 0) return i;
    const g = rows.findIndex((r) => pickable(r) && test(r.group.name.toLowerCase()));
    if (g >= 0) return g;
  }
  const any = rows.findIndex(pickable);
  return any >= 0 ? any : 0;
}
