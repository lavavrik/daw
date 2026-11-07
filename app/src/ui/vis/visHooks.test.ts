import { describe, expect, it } from 'vitest';
import { createVisHooks } from './visHooks';
import { SCOPE_HDR, VIS_HDR, visBytes, visViews } from '../../audio/visLayout';
import { VIS_SCOPE_HDR } from '../../audio/protocol';
import { Ballistics, Bands, DB_FLOOR } from './spectrum';

function deps() {
  const v = visViews(new SharedArrayBuffer(visBytes()));
  const bands = new Bands(60, 48000);
  const panel = new Ballistics(60);
  let engine: { vis(): typeof v } | null = { vis: () => v };
  const loop = { stats: () => ({ busyMs: 1, wallMs: 100, frames: 6 }), drawn: () => 42, running: () => true, tap: () => 3 };
  const hooks = createVisHooks({ engine: () => engine, loop, bus: { panel, panelBands: bands } });
  return { v, bands, panel, hooks, detach: () => (engine = null) };
}

describe('visHooks (window.__daw.vis)', () => {
  it('scopeHead finds the slot by owner and reads its head', () => {
    const { v, hooks, detach } = deps();
    const hdr = (s: number, f: number) => VIS_HDR.scopes + s * VIS_SCOPE_HDR + f;
    for (let s = 0; s < 8; s++) v.hdr[hdr(s, SCOPE_HDR.ownerTrack)] = -1;
    v.hdr[hdr(5, SCOPE_HDR.ownerTrack)] = 2;
    v.hdr[hdr(5, SCOPE_HDR.ownerModule)] = 8;
    v.hdr[hdr(5, SCOPE_HDR.head)] = 1234;
    expect(hooks.scopeHead(2, 8)).toBe(1234);
    expect(hooks.scopeHead(2, 9)).toBe(-1);
    detach();
    expect(hooks.scopeHead(2, 8)).toBe(-1);
  });

  it('peakHz is the loudest band centre, null when everything sits on the floor', () => {
    const { panel, bands, hooks } = deps();
    expect(hooks.analyser.peakHz()).toBeNull();
    const raw = new Float32Array(60).fill(DB_FLOOR);
    const k = bands.bandOf(880);
    raw[k] = -6;
    raw[k - 3] = -20;
    panel.step(raw, 1 / 30);
    expect(hooks.analyser.peakHz()).toBe(bands.centre[k]);
  });

  it('passes the loop through and reads the want mask', () => {
    const { v, hooks, detach } = deps();
    v.hdr[VIS_HDR.want] = 9;
    expect(hooks.want()).toBe(9);
    expect(hooks.stats()).toEqual({ busyMs: 1, wallMs: 100, frames: 6 });
    expect(hooks.drawn()).toBe(42);
    expect(hooks.running()).toBe(true);
    expect(hooks.analyser.tap()).toBe(3);
    detach();
    expect(hooks.want()).toBe(0);
  });
});
