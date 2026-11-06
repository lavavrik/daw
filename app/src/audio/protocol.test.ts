import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Op, Err } from './protocol';

const src = readFileSync(new URL('../../../engine/src/protocol.rs', import.meta.url), 'utf8');

describe('protocol parity with engine/src/protocol.rs', () => {
  const rust: Record<string, number> = {};
  for (const m of src.matchAll(/pub const (OP_\w+|ERR_\w+|OK): (?:u32|i32) = (-?\d+);/g)) {
    rust[m[1]] = Number(m[2]);
  }
  const ts: Record<string, number> = {};
  for (const [k, v] of Object.entries(Op)) ts[`OP_${k}`] = v;
  for (const [k, v] of Object.entries(Err)) ts[k === 'OK' ? 'OK' : `ERR_${k}`] = v;

  it('parsed a sane number of constants', () => {
    expect(Object.keys(rust).length).toBe(22);
  });
  it('Rust and TS have identical names and values', () => {
    expect(ts).toEqual(rust);
  });
});
