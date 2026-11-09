// What an automation lane's header calls its target (plan 10), pure and
// unit-tested (autoLabels.test.ts). Mixer params by what the strip says
// ("Fader", "Pan", "EQ Low cut", "Hall send": a send reads
// its return's name), Master row lanes prefixed
// by their channel: the master or the return's name ("Master · Ceiling",
// "Delay · Feedback"), rack params by
// the module's title as the rack shows it ("Filter · Cutoff"; "Osc 2 ·
// Tune" when the rack has more than one) and the knob's label.
import { moduleDef } from '../../audio/catalog';
import { MIX_PARAMS } from '../../audio/mixerCatalog';
import type { MixParamDef } from '../../audio/mixerCatalog';
import type { AutoOwner } from '../../state/automation';
import { findReturn, sendSlotOf } from '../../state/returns';
import type { AutoTarget, MasterChannel, Project, RackModule } from '../../state/project.svelte';

/** A Master row channel as a lane or picker names it: "Master", or the return's name. */
export const channelName = (p: Project, ch: MasterChannel): string => (ch === 'master' ? 'Master' : (findReturn(p, ch)?.name ?? '?'));

/** A mixer param as a lane names it. */
export function mixLabel(def: MixParamDef, p?: Project): string {
  if (def.name === 'fader') return 'Fader';
  if (def.group === 'send') {
    // "Hall send" (the return on that slot); a slot with no return keeps the catalog's "Send 5".
    const slot = sendSlotOf(def.name);
    const r = p && slot !== null ? p.mixer.returns.find((x) => x.slot === slot) : undefined;
    return r ? `${r.name} send` : def.label;
  }
  if (def.group === 'eq') return `EQ ${def.label}`;
  if (def.group === 'comp') return `Comp ${def.label}`;
  return def.label;
}

/** Module titles as the rack shows them: the catalog name, numbered when the rack has more than one of that kind. */
export function moduleTitles(modules: readonly Pick<RackModule, 'idx' | 'kind'>[]): Map<number, string> {
  const total = new Map<number, number>();
  for (const m of modules) total.set(m.kind, (total.get(m.kind) ?? 0) + 1);
  const seen = new Map<number, number>();
  const out = new Map<number, string>();
  for (const m of [...modules].sort((a, b) => a.idx - b.idx)) {
    const n = (seen.get(m.kind) ?? 0) + 1;
    seen.set(m.kind, n);
    const name = moduleDef(m.kind).name;
    out.set(m.idx, total.get(m.kind)! > 1 ? `${name} ${n}` : name);
  }
  return out;
}

/** The header text of `owner`'s lane on `target` (in `p`: a return's lanes are prefixed by its name). */
export function targetLabel(p: Project, owner: AutoOwner, target: AutoTarget): string {
  if (target.kind === 'mix') {
    const def = MIX_PARAMS.find((d) => d.name === target.param);
    const label = def ? mixLabel(def, p) : target.param;
    return typeof owner === 'string' ? `${channelName(p, owner)} · ${label}` : label;
  }
  if (typeof owner === 'string' || owner.kind !== 'synth') return target.param;
  const m = owner.modules.find((x) => x.idx === target.module);
  const def = m ? moduleDef(m.kind).params.find((d) => d.name === target.param) : undefined;
  return `${moduleTitles(owner.modules).get(target.module) ?? '?'} · ${def?.label ?? target.param}`;
}
