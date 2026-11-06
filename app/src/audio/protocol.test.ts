import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Op, Err, MAX_BLOCK, MAX_SAMPLE_FLOATS, MAX_MODULES, MAX_POLY, MAX_PORTS, MAX_PARAMS, TELEMETRY, TELEMETRY_LEN,
} from './protocol';
import { MAX_ROWS, MAX_SAMPLES, MAX_STEPS, MAX_TRACKS } from '../state/project.svelte';

const read = (f: string) => readFileSync(new URL(`../../../engine/src/${f}`, import.meta.url), 'utf8');

describe('protocol parity with engine/src/protocol.rs', () => {
  const src = read('protocol.rs');
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

describe('size and telemetry parity with engine/src/lib.rs', () => {
  // `pub const NAME: usize = <integer product>;`, e.g. `64 * 1024 * 1024`.
  const rust: Record<string, number> = {};
  for (const m of read('lib.rs').matchAll(/pub const ((?:MAX|TELEMETRY)_\w+): usize = ([\d\s*]+);/g)) {
    rust[m[1]] = m[2].split('*').reduce((p: number, x: string) => p * Number(x.trim()), 1);
  }
  const snake = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); // peakL -> PEAK_L
  const ts: Record<string, number> = {
    MAX_BLOCK, MAX_TRACKS, MAX_ROWS, MAX_STEPS, MAX_SAMPLES, MAX_SAMPLE_FLOATS, TELEMETRY_LEN,
    MAX_MODULES, MAX_POLY, MAX_PORTS, MAX_PARAMS,
  };
  for (const [k, v] of Object.entries(TELEMETRY)) ts[`TELEMETRY_${snake(k)}`] = v;

  it('parsed every MAX_* and TELEMETRY_* constant', () => {
    expect(Object.keys(rust).length).toBe(10 + 9);
  });
  it('Rust and TS have identical names and values', () => {
    expect(ts).toEqual(rust);
  });
});
