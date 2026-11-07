// What an automation lane's header calls its target (plan 10), pure and
// unit-tested (autoLabels.test.ts). Mixer params by what the strip says
// ("Fader", "Pan", "EQ Low cut", "Reverb send"), Master row lanes prefixed
// by their channel ("Master · Ceiling", "Delay · Feedback"), rack params by
// the module's title as the rack shows it ("Filter · Cutoff"; "Osc 2 ·
// Tune" when the rack has more than one) and the knob's label.
import { moduleDef } from '../../audio/catalog';
import { MIX_PARAMS } from '../../audio/mixerCatalog';
import type { MixParamDef } from '../../audio/mixerCatalog';
import { automatableParams, isMasterChannel } from '../../state/automation';
import type { AutoOwner } from '../../state/automation';
import type { AutoTarget, MasterChannel, RackModule } from '../../state/project.svelte';

const CHANNEL: Record<MasterChannel, string> = { master: 'Master', reverb: 'Reverb', delay: 'Delay' };

/** A mixer param as a lane names it. */
export function mixLabel(def: MixParamDef): string {
  if (def.name === 'fader') return 'Fader';
  if (def.group === 'send') return `${def.label} send`;
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

/** The header text of `owner`'s lane on `target`. */
export function targetLabel(owner: AutoOwner, target: AutoTarget): string {
  if (target.kind === 'mix') {
    const def = MIX_PARAMS.find((d) => d.name === target.param);
    const label = def ? mixLabel(def) : target.param;
    return isMasterChannel(owner) ? `${CHANNEL[owner]} · ${label}` : label;
  }
  if (isMasterChannel(owner) || owner.kind !== 'synth') return target.param;
  const m = owner.modules.find((x) => x.idx === target.module);
  const def = m ? moduleDef(m.kind).params.find((d) => d.name === target.param) : undefined;
  return `${moduleTitles(owner.modules).get(target.module) ?? '?'} · ${def?.label ?? target.param}`;
}

/** "+ Lane" choices for `owner`: its automatable targets that have no lane yet, in automatableParams order. */
export function laneChoices(owner: AutoOwner, used: readonly AutoTarget[]): { target: AutoTarget; label: string }[] {
  const key = (t: AutoTarget) => (t.kind === 'mix' ? `mix:${t.param}` : `rack:${t.module}:${t.param}`);
  const taken = new Set(used.map(key));
  return automatableParams(owner).filter((x) => !taken.has(key(x.target))).map((x) => ({ target: x.target, label: targetLabel(owner, x.target) }));
}
