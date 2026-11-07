import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Op, Err, MAX_BLOCK, MAX_SAMPLE_FLOATS, MAX_MODULES, MAX_POLY, MAX_PORTS, MAX_PARAMS, TELEMETRY, TELEMETRY_LEN,
  PORT_STRIDE, packPort, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS, BAR_TICKS, MAX_CLIPS, MAX_SONG_TICKS, STEP_TICKS,
  MAX_KEYS, MIX_REVERB, MIX_DELAY, MIX_MASTER, MIX_CHANNELS, MIX_METER_STRIDE, keyCode,
  MAX_ARENA_FLOATS, MAX_CLIP_GAIN, CLIP_FADE_SECONDS, MAX_AUTO_LANES, MAX_AUTO_POINTS, AUTO_KIND, packAutoParam,
  autoPoint, VIS_SCOPES, VIS_SCOPE_RING, VIS_SCOPE_WINDOW, VIS_SCOPE_HDR, VIS_TAP_RING, VIS_VOICE_LEN,
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
    expect(Object.keys(rust).length).toBe(61);
  });
  it('Rust and TS have identical names and values', () => {
    expect(ts).toEqual(rust);
  });
  it('packs ports with the same stride as the engine', () => {
    const m = src.match(/pub const PORT_STRIDE: usize = (\d+);/);
    expect(Number(m?.[1])).toBe(PORT_STRIDE);
    expect(packPort(2, 1)).toBe(33);
  });
  it('packs automation targets and points like the engine', () => {
    expect(packAutoParam(4, 1)).toBe(65);
    expect(autoPoint(3, 511)).toBe(3 * 512 + 511);
    expect(AUTO_KIND).toEqual({ NONE: 0, MIX: 1, RACK: 2 });
    expect(src).toMatch(/OP_AUTO_LANE_SET: u32 = 49; \/\/ a=lane b=kind 0 none\/1 mix\/2 rack/);
  });
});

describe('size and telemetry parity with engine/src/lib.rs', () => {
  // `pub const NAME: usize = <integer product>;`, e.g. `64 * 1024 * 1024`.
  const rust: Record<string, number> = {};
  for (const m of read('lib.rs').matchAll(/pub const ((?:MAX|TELEMETRY|MIX|VIS)_\w+): usize = ([\d\s*]+);/g)) {
    rust[m[1]] = m[2].split('*').reduce((p: number, x: string) => p * Number(x.trim()), 1);
  }
  const snake = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); // peakL -> PEAK_L
  const ts: Record<string, number> = {
    MAX_BLOCK, MAX_TRACKS, MAX_ROWS, MAX_STEPS, MAX_SAMPLES, MAX_SAMPLE_FLOATS, TELEMETRY_LEN,
    MAX_MODULES, MAX_POLY, MAX_PORTS, MAX_PARAMS, MAX_NOTES, MAX_PATTERN_BARS, MAX_PATTERNS, MAX_CLIPS, MAX_SONG_TICKS,
    MAX_KEYS, MIX_REVERB, MIX_DELAY, MIX_MASTER, MIX_CHANNELS, MIX_METER_STRIDE, MAX_ARENA_FLOATS,
    MAX_AUTO_LANES, MAX_AUTO_POINTS,
    VIS_SCOPES, VIS_SCOPE_RING, VIS_SCOPE_WINDOW, VIS_SCOPE_HDR, VIS_TAP_RING, VIS_VOICE_LEN,
  };
  for (const [k, v] of Object.entries(TELEMETRY)) ts[`TELEMETRY_${snake(k)}`] = v;

  it('parsed every MAX_*, TELEMETRY_*, MIX_* and VIS_* constant', () => {
    expect(Object.keys(rust).length).toBe(19 + 10 + 5 + 6);
  });
  it('Rust and TS have identical names and values', () => {
    expect(ts).toEqual(rust);
  });
  it('STEP_TICKS matches', () => {
    const m = read('lib.rs').match(/pub const STEP_TICKS: f64 = ([\d.]+);/);
    expect(Number(m?.[1])).toBe(STEP_TICKS);
  });

  it('BAR_TICKS matches', () => {
    const m = read('lib.rs').match(/pub const BAR_TICKS: f64 = ([\d.]+);/);
    expect(Number(m?.[1])).toBe(BAR_TICKS);
  });

  it('audio-clip f32 limits match', () => {
    const f32 = (name: string) => Number(read('lib.rs').match(new RegExp(`pub const ${name}: f32 = ([\\d.]+);`))?.[1]);
    expect(f32('MAX_CLIP_GAIN')).toBe(MAX_CLIP_GAIN);
    expect(f32('CLIP_FADE_SECONDS')).toBe(CLIP_FADE_SECONDS);
  });
});

describe('mixer constants', () => {
  it('channels follow the track strips', () => {
    expect([MIX_REVERB, MIX_DELAY, MIX_MASTER, MIX_CHANNELS]).toEqual([32, 33, 34, 35]);
  });
  it('key codes pack slot*32 (+ row + 1)', () => {
    expect(keyCode(null)).toBe(-1);
    expect(keyCode({ slot: 2 })).toBe(64);
    expect(keyCode({ slot: 2, row: 0 })).toBe(65);
    expect(keyCode({ slot: 31, row: 15 })).toBe(31 * 32 + 16);
  });
});

describe('mixer catalog golden', () => {
  const cat = JSON.parse(readFileSync(new URL('../../../engine/mixer_catalog.json', import.meta.url), 'utf8'));
  it('channels match the constants', () => {
    expect(cat.channels).toEqual({ tracks: 32, reverb: MIX_REVERB, delay: MIX_DELAY, master: MIX_MASTER });
  });
  it('param ids are their positions, defaults in range', () => {
    cat.params.forEach((p: { id: number; min: number; max: number; default: number }, i: number) => {
      expect(p.id).toBe(i);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
    });
  });
  it('the EQ low cut labels its minimum Off', () => {
    const hp = cat.params.find((p: { name: string }) => p.name === 'eq_hp');
    expect(hp.minLabel).toBe('Off');
    expect(hp.min).toBe(20);
  });
});
