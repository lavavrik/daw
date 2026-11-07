// window.__daw.vis: what the e2e tests (and the console) can ask the visuals
// (plan 12 Task 6; tests/e2e/visuals.spec.ts and serial.spec.ts). Read-only:
// nothing here changes a view or the engine.
//
//   stats()            the frame loop's main-thread cost over the last 5 s
//   drawn(), running() frames drawn since start, whether the rAF is scheduled
//   want()             the want mask in visSab (0: the worklet copies nothing)
//   scopeHead(t, i)    the mirrored head of the Scope at (track slot, module idx), -1 if none
//   analyser.peakHz()  the centre of the panel's loudest band (null: all on the floor)
//   analyser.tap()     the strip tap the engine was given (-1: off)
import { SCOPE_HDR, VIS_HDR, type VisViews } from '../../audio/visLayout';
import { VIS_SCOPE_HDR, VIS_SCOPES } from '../../audio/protocol';
import type { FrameLoop, FrameStats } from './frameLoop';
import { findScope } from './scopeMath';
import { DB_FLOOR } from './spectrum';

export interface VisHooks {
  stats(): FrameStats;
  drawn(): number;
  running(): boolean;
  want(): number;
  scopeHead(track: number, idx: number): number;
  analyser: { peakHz(): number | null; tap(): number };
}

export interface VisHookDeps {
  engine: () => { vis(): VisViews } | null;
  loop: Pick<FrameLoop, 'stats' | 'drawn' | 'running' | 'tap'>;
  bus: { readonly panel: { readonly level: Float32Array }; readonly panelBands: { readonly centre: Float64Array } };
}

export function createVisHooks(d: VisHookDeps): VisHooks {
  return {
    stats: () => d.loop.stats(),
    drawn: () => d.loop.drawn(),
    running: () => d.loop.running(),
    want: () => {
      const v = d.engine()?.vis();
      return v ? Atomics.load(v.hdr, VIS_HDR.want) : 0;
    },
    scopeHead(track, idx) {
      const v = d.engine()?.vis();
      if (!v) return -1;
      const hdrs = v.hdr.subarray(VIS_HDR.scopes, VIS_HDR.scopes + VIS_SCOPES * VIS_SCOPE_HDR);
      const s = findScope(hdrs, track, idx);
      return s < 0 ? -1 : Atomics.load(hdrs, s * VIS_SCOPE_HDR + SCOPE_HDR.head);
    },
    analyser: {
      peakHz() {
        const level = d.bus.panel.level;
        let k = -1;
        let max = DB_FLOOR;
        for (let i = 0; i < level.length; i++) {
          if (level[i] > max) {
            max = level[i];
            k = i;
          }
        }
        return k < 0 ? null : d.bus.panelBands.centre[k];
      },
      tap: () => d.loop.tap(),
    },
  };
}
