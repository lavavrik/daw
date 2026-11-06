// Typed view of engine/catalog.json, the golden module catalog generated from
// the Rust tables (Rust test `catalog_matches_golden`). The UI never hand-copies
// module, port or param definitions; it reads them from here.
import raw from '../../../engine/catalog.json';

export type SignalKind = 'audio' | 'cv' | 'gate' | 'pitch';

export interface PortDef {
  name: string;
  signal: SignalKind;
}

export interface ParamDef {
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  integer: boolean;
  curve: 'lin' | 'exp';
  unit: string;
  /** Labels for enum-like params (value = index); empty for continuous ones. */
  choices: string[];
  smooth: boolean;
}

export interface ModuleDef {
  /** Numeric kind sent in RACK_ADD_MODULE. */
  kind: number;
  id: string;
  name: string;
  category: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
}

export interface Catalog {
  version: number;
  rackBlock: number;
  maxModules: number;
  maxPoly: number;
  modules: ModuleDef[];
}

export const CATALOG = raw as Catalog;

/** Look up by string id ("osc") or numeric kind. Throws on unknown. */
export function moduleDef(idOrKind: string | number): ModuleDef {
  const def = CATALOG.modules.find((m) => (typeof idOrKind === 'number' ? m.kind === idOrKind : m.id === idOrKind));
  if (!def) throw new Error(`unknown module ${idOrKind}`);
  return def;
}

export function paramIndex(def: ModuleDef, name: string): number {
  const i = def.params.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`${def.id} has no param ${name}`);
  return i;
}

export function portIndex(def: ModuleDef, dir: 'in' | 'out', name: string): number {
  const i = (dir === 'in' ? def.inputs : def.outputs).findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`${def.id} has no ${dir} port ${name}`);
  return i;
}

/** Clamp to [min,max]; integer params also round. NaN falls back to the default. */
export function clampParam(def: ParamDef, v: number): number {
  if (Number.isNaN(v)) return def.default;
  const c = Math.min(def.max, Math.max(def.min, v));
  return def.integer ? Math.round(c) : c;
}
