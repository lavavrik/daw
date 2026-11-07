// The knob-follow loop (plan 10 Task 4; docs/architecture/automation.md "UI").
// Like the mixer's meterBus: ONE requestAnimationFrame loop for every
// automatable control on screen. Each knob or fader registers its target
// (owner + AutoTarget) with a callback; each frame the bus reads the heard
// tick once, evaluates laneValueAt for every registered control whose target
// has a lane, and calls the callback ONLY when what it shows changed. The
// controls write their ring / cap straight into the DOM: no reactive state
// per frame, no Svelte re-render.
//
// What a control shows (AutoView.status):
//   none       no lane on its target: its own (base) value;
//   on         the lane applies (Song mode, enabled, has points, not
//              suspended): `value` is the lane's value at the HEARD tick
//              (while stopped: at the parked song position, where the
//              engine applies it too);
//   idle       a lane exists but plays nothing: Pattern mode, disabled, or
//              no points. The base plays and is shown;
//   suspended  a manual move overrode the lane (AUTO_OVERRIDE): the base
//              plays and is shown, the lane is drawn grey.
//
// Override (the engine's rule, engine/src/automation.rs Automation::suspend,
// recomputed here from the same data): `touch()` sends AUTO_OVERRIDE and
// suspends the lane, while playing until the lane's next breakpoint after the
// ENGINE's tick at that moment (the tick the engine itself uses), while
// stopped until the next jump. It ends when the HEARD tick reaches that point
// (so the grey ends when the lane is heard again), or at any jump: Play,
// Stop, a seek, a mode switch (a change of playing / mode / songPosition) or
// a loop wrap (the heard tick going back).
//
// The loop runs only while the transport plays in Song mode and at least one
// control is registered (registered = mounted = visible; a hidden tab gets
// no rAF anyway). Otherwise App calls `refresh()` when something the controls
// show may have changed (an edit, Play / Stop, a seek, a mode switch, a load).
import { getContext, setContext } from 'svelte';
import type { CommandSink } from '../state/actions';
import { isMasterChannel, laneValueAt, nextBreakpoint, projectLanes, targetDef } from '../state/automation';
import type { AutoDef } from '../state/automation';
import { overrideLane } from '../state/automation-actions';
import type { MixChannelTarget } from '../state/mixer-actions';
import type { AutoTarget, AutomationLane, Project } from '../state/project.svelte';

export type AutoStatus = 'none' | 'on' | 'idle' | 'suspended';

export interface AutoView {
  status: AutoStatus;
  /** The lane's value (param units) while it applies (`on`); null: show the base. */
  value: number | null;
  /** The lane on the control's target, if any. */
  laneId: string | null;
}

export type AutoFn = (v: AutoView) => void;

export interface AutoBusDeps {
  project: Project;
  sink: CommandSink;
  /** The tick heard now (AudioClock.heardTicks); NaN when unknown. */
  heardTicks: () => number;
  /** The engine's playhead (telemetry ticks): where AUTO_OVERRIDE's "next breakpoint" is counted from. */
  engineTicks: () => number;
  /** The suspended lane ids changed (App: laneView.suspended, drawn grey on the timeline). */
  onSuspended: (ids: Set<string>) => void;
  raf?: (fn: () => void) => number;
  caf?: (id: number) => void;
}

export interface AutoBus {
  /** Follow `target` on `owner` (a track id, or 'reverb' / 'delay' / 'master'); returns the unregister. */
  register(owner: MixChannelTarget, target: AutoTarget, fn: AutoFn): () => void;
  /**
   * A manual move of the control is about to be sent: in Song mode, with an
   * enabled lane with points, send AUTO_OVERRIDE and suspend the lane (true).
   * Otherwise nothing (false): the move is just the normal action.
   */
  touch(owner: MixChannelTarget, target: AutoTarget): boolean;
  /** `target` can have a lane on `owner` (a continuous param it has): "Automate" is offered. */
  canAutomate(owner: MixChannelTarget, target: AutoTarget): boolean;
  /** The lane on `target` of `owner`, or null. */
  laneFor(owner: MixChannelTarget, target: AutoTarget): AutomationLane | null;
  /** Evaluate every control now (and start the loop if it should run). */
  refresh(): void;
  /** One frame: evaluate and notify (the loop's body; tests drive it by hand). */
  frame(): void;
}

/** A heard tick this far behind the last one is a jump (loop wrap, seek), not clock jitter. */
const JUMP_BACK = 120;

const targetKey = (t: AutoTarget) => (t.kind === 'mix' ? `mix:${t.param}` : `rack:${t.module}:${t.param}`);
const keyOf = (owner: string, t: AutoTarget) => `${owner}|${targetKey(t)}`;

interface Reg {
  key: string;
  fn: AutoFn;
  last: AutoView | null;
}

export function createAutoBus(d: AutoBusDeps): AutoBus {
  const p = d.project;
  const raf = d.raf ?? ((fn: () => void) => requestAnimationFrame(fn));
  const caf = d.caf ?? ((id: number) => cancelAnimationFrame(id));
  const regs = new Set<Reg>();
  /** Suspended lane id -> the tick it ends at (Infinity: at the next jump). */
  const suspended = new Map<string, number>();
  let sig = '';
  let lastHeard = NaN;
  let loopId = 0;

  /** Every lane by owner|target, with its def (lanes whose target is gone are skipped). */
  function lanes(): Map<string, { lane: AutomationLane; def: AutoDef }> {
    const m = new Map<string, { lane: AutomationLane; def: AutoDef }>();
    for (const x of projectLanes(p)) {
      const def = targetDef(x.owner, x.lane.target);
      if (def) m.set(keyOf(isMasterChannel(x.owner) ? x.owner : x.owner.id, x.lane.target), { lane: x.lane, def });
    }
    return m;
  }

  const setSuspended = (changed: boolean) => {
    if (changed) d.onSuspended(new Set(suspended.keys()));
  };

  /** The tick the controls show: heard while playing, the parked song position while stopped. */
  function shownTick(): number {
    if (!p.playing) return p.songPosition;
    const t = d.heardTicks();
    return Number.isFinite(t) ? Math.max(0, t) : p.songPosition;
  }

  /** End suspensions on a jump (Play, Stop, seek, mode switch, loop wrap) or once their point is heard. */
  function transport(tick: number) {
    const s = `${p.playing}|${p.mode}|${p.songPosition}`;
    let changed = false;
    const wrapped = p.playing && Number.isFinite(lastHeard) && tick < lastHeard - JUMP_BACK;
    if (s !== sig || wrapped) {
      changed = suspended.size > 0;
      suspended.clear();
    } else if (p.playing) {
      for (const [id, until] of suspended) {
        if (tick >= until) {
          suspended.delete(id);
          changed = true;
        }
      }
    }
    sig = s;
    lastHeard = p.playing ? tick : NaN;
    setSuspended(changed);
  }

  function evaluate(r: Reg, all: Map<string, { lane: AutomationLane; def: AutoDef }>, tick: number) {
    const x = all.get(r.key);
    let v: AutoView;
    if (!x) v = { status: 'none', value: null, laneId: null };
    else if (suspended.has(x.lane.id)) v = { status: 'suspended', value: null, laneId: x.lane.id };
    else {
      const value = p.mode === 'song' && x.lane.enabled ? laneValueAt(x.lane.points, tick, x.def) : null;
      v = { status: value === null ? 'idle' : 'on', value, laneId: x.lane.id };
    }
    const l = r.last;
    if (l && l.status === v.status && l.value === v.value && l.laneId === v.laneId) return;
    r.last = v;
    r.fn(v);
  }

  function frame() {
    const tick = shownTick();
    transport(tick);
    if (regs.size === 0) return;
    const all = lanes();
    for (const id of suspended.keys()) {
      if (![...all.values()].some((x) => x.lane.id === id)) {
        suspended.delete(id);
        setSuspended(true);
      }
    }
    for (const r of regs) evaluate(r, all, tick);
  }

  const shouldLoop = () => regs.size > 0 && p.playing && p.mode === 'song';
  function loop() {
    loopId = 0;
    frame();
    ensureLoop();
  }
  function ensureLoop() {
    if (loopId || !shouldLoop()) return;
    loopId = raf(loop);
  }

  return {
    register(owner, target, fn) {
      const r: Reg = { key: keyOf(owner, target), fn, last: null };
      regs.add(r);
      evaluate(r, lanes(), shownTick());
      ensureLoop();
      return () => {
        regs.delete(r);
        if (regs.size === 0 && loopId) {
          caf(loopId);
          loopId = 0;
        }
      };
    },
    touch(owner, target) {
      if (p.mode !== 'song') return false;
      const x = lanes().get(keyOf(owner, target));
      if (!x || !x.lane.enabled || x.lane.points.length === 0) return false;
      transport(shownTick()); // a jump before this move ends the OLD suspensions, not this one
      if (!overrideLane(p, d.sink, x.lane.id)) return false;
      let until = Infinity;
      if (p.playing) {
        const e = d.engineTicks();
        const from = Number.isFinite(e) ? e : shownTick();
        until = nextBreakpoint(x.lane.points, from)?.tick ?? Infinity;
      }
      const isNew = !suspended.has(x.lane.id);
      suspended.set(x.lane.id, until);
      setSuspended(isNew);
      return true;
    },
    canAutomate(owner, target) {
      const o = isMasterChannel(owner) ? owner : p.tracks.find((t) => t.id === owner);
      return !!o && targetDef(o, target) !== null;
    },
    laneFor(owner, target) {
      return lanes().get(keyOf(owner, target))?.lane ?? null;
    },
    refresh() {
      frame();
      ensureLoop();
    },
    frame,
  };
}

const KEY = Symbol('autoBus');
/** App: make `bus` the one every Knob / Fader below registers with. */
export const provideAutoBus = (bus: AutoBus) => setContext(KEY, bus);
/** A control's bus (undefined outside App, e.g. a component test): then it just shows its own value. */
export const useAutoBus = (): AutoBus | undefined => getContext<AutoBus | undefined>(KEY);
