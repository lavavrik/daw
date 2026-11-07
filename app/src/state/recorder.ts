// Live recording of played notes into the live-input synth track's current
// pattern (Pattern mode only).
//
// Pure: the clock and the pattern actions are injected (recorderFor() wires
// the real ones), so every timing rule below is unit-tested with fakes.
//
// Rules (plan 3, global constraints "Recording"):
// - A *pass* begins when the transport starts playing while armed, or when
//   arming while already playing. Recording is active while
//   armed && playing && the note's heard tick >= 0 (nothing during count-in).
// - Time is the *heard* time: clock.ticksForEvent(event.timeStamp, offsetMs),
//   i.e. the tick the user was hearing when they hit the key (Bluetooth adds
//   ~250 ms; offsetMs is a user trim, positive = notes land earlier).
// - Grace window: a note-on up to GRACE_TICKS before tick 0 (a hair early on
//   the downbeat after the count-in, or clock jitter) is recorded at tick 0.
// - Ticks are absolute transport ticks (monotonic while playing); a note's
//   pattern start is mod(tick, period), its length endTick - startTick, so a
//   note held across the loop end gets end + period - start. Clamped 1..period;
//   a slightly negative length (note-on and note-off are mapped through
//   different getOutputTimestamp snapshots, so they can disagree by a tick or
//   two) becomes 1, never a whole loop.
// - Sustain pedal (per source): while it is down a key-up does not end the
//   recorded note; pedal-up ends every such note at the pedal event's heard
//   tick. Re-striking a pedal-held pitch ends the old note there.
// - The note is written (addNote) on release. Notes still held when recording
//   becomes inactive (stop, disarm) close at that moment's heard tick.
// - The target (track, current pattern) is captured at the first recorded
//   note-on and kept until the live input, the mode or the target's current
//   pattern changes: onInputChanged(ticksNow) (App calls it when
//   liveInputTrack() or the mode changes) and onPatternChanging(trackId,
//   ticksNow) (selectPattern calls it via p.beforePatternSwitch, BEFORE the
//   engine switches, so the notes still land in the old pattern) close every
//   open note at that tick -- the engine cuts live-held pitches there too --
//   and end the take; the next note-on retargets and starts a fresh take.
// - Song mode: recording is disabled. toggleArm() is a no-op (disarming
//   still works), and nothing records while deps.songMode() is true.
// - Overdub: notes merge into the pattern; the same pitch at the same start
//   twice in one pass on one (track, pattern) is written once. That set is
//   cleared only at pass start and by undo.
// - A *take* is the notes added to one (track, pattern) since the last
//   retarget; undoLastTake() removes exactly those. An empty pass does not
//   replace the previous take. Undo of a take whose pattern is not current
//   first selects that pattern (a visible switch, never switched back: the
//   engine edits only the current one); a take whose track or pattern is gone
//   is dropped (status().takeNotes = 0, Undo disabled).
import { BAR_TICKS, MAX_NOTES } from '../audio/protocol';
import { mod } from '../audio/audioClock';
import { liveInputTrack } from './actions';
import type { CommandSink } from './actions';
import { addNote, deleteNotes, patternOf, selectPattern } from './pattern-actions';
import { currentPattern, synthTrack } from './project.svelte';
import type { NotePatternState, Project, SynthTrack } from './project.svelte';
import type { NoteListener } from '../input/noteInput';

export const REC_OFFSET_MIN = -200;
export const REC_OFFSET_MAX = 200;
/** Note-ons this many ticks before tick 0 still record (at 0): 1/64 note at 960 PPQ. */
export const GRACE_TICKS = 60;

/** The slice of AudioClock the recorder uses. */
export interface RecorderClock {
  heardTicks(): number;
  ticksForEvent(perfMs: number, offsetMs: number): number;
}

export interface RecorderDeps {
  clock: RecorderClock;
  /** Track that would receive a recording now (the live-input synth); its current pattern is the target. */
  target(): SynthTrack | null;
  /** Null when it could not be added (full, track gone, pattern no longer current). */
  addNote(
    trackId: string, patternId: string, o: { pitch: number; start: number; len: number; vel: number },
  ): { id: string } | null;
  /**
   * Removes a take: selects `patternId` if it is not current (this may call
   * onPatternChanging, closing held notes into a new take), then deletes.
   */
  deleteNotes(trackId: string, patternId: string, ids: string[]): void;
  /** False once the take's track or pattern was removed (default: true). */
  patternExists?(trackId: string, patternId: string): boolean;
  /** True in Song mode: recording is disabled. */
  songMode?(): boolean;
  /** The pattern is full (MAX_NOTES); called once per pass. */
  onFull?(): void;
}

export type RecState = 'off' | 'armed' | 'count-in' | 'recording';

/** Snapshot for the UI (compare with sameStatus before assigning to $state). */
export interface RecStatus {
  armed: boolean;
  state: RecState;
  /** Notes in the last take (Undo take is enabled when > 0). */
  takeNotes: number;
}

export const sameStatus = (a: RecStatus, b: RecStatus) =>
  a.armed === b.armed && a.state === b.state && a.takeNotes === b.takeNotes;

interface Open {
  pitch: number;
  vel: number;
  /** Absolute heard tick of the note-on. */
  tick: number;
  /** Key released while the source's pedal was down: ends at pedal-up. */
  pedalHeld: boolean;
}

export class Recorder implements NoteListener {
  armed = false;
  /** Count-in on Play while armed (one bar). The UI persists it. */
  countIn = false;
  /** Ids of the notes the last take added (on lastTakeTrackId / lastTakePatternId). */
  lastTakeIds: string[] = [];
  lastTakeTrackId: string | null = null;
  lastTakePatternId: string | null = null;

  #offsetMs = 0;
  #playing = false;
  /** Pass state. */
  #track: SynthTrack | null = null;
  #pattern: NotePatternState | null = null;
  #takeStarted = false;
  #written = new Set<string>(); // `${trackId}:${patternId}:${pitch}:${start}` written this pass
  #fullReported = false;
  /** Open (held, recording) notes by `${source}:${pitch}`. */
  #open = new Map<string, Open>();
  /** Sources whose sustain pedal is down (tracked even when not recording). */
  #pedal = new Set<string>();

  private deps: RecorderDeps;
  constructor(deps: RecorderDeps) {
    this.deps = deps;
  }

  /** Heard-time trim in ms, clamped to -200..200 (NaN -> 0). */
  get offsetMs() {
    return this.#offsetMs;
  }
  set offsetMs(v: number) {
    this.#offsetMs = Number.isFinite(v) ? Math.min(REC_OFFSET_MAX, Math.max(REC_OFFSET_MIN, Math.round(v))) : 0;
  }

  /** Transport state as last reported through onTransport. */
  get playing() {
    return this.#playing;
  }

  /** Count-in ticks to pass to play(): one bar when armed with Count-in on, else 0. */
  countInTicks(): number {
    return this.armed && this.countIn && !this.#song() ? BAR_TICKS : 0;
  }

  #song(): boolean {
    return this.deps.songMode?.() ?? false;
  }

  /** No-op in Song mode unless disarming. */
  toggleArm() {
    if (!this.armed && this.#song()) return;
    this.armed = !this.armed;
    if (this.armed) {
      if (this.#playing) this.#beginPass();
    } else {
      this.#closeAll(this.deps.clock.heardTicks());
    }
  }

  /**
   * Transport edges. `ticksNow` is the heard tick at the moment of the change;
   * on stop, held notes close there. Repeated calls with the same state are no-ops.
   */
  onTransport(playing: boolean, ticksNow: number) {
    if (playing === this.#playing) return;
    if (!playing) this.#closeAll(ticksNow);
    this.#playing = playing;
    if (playing) this.#beginPass();
  }

  /**
   * The live-input track changed (select, remove, add). `ticksNow` is the
   * heard tick at the switch: held notes end there on the old track, and the
   * next recorded note-on picks the new target and starts a new take (the
   * previous take stays undoable until then). Safe to call at any time.
   */
  onInputChanged(ticksNow: number) {
    this.#closeAll(ticksNow);
    this.#newTarget();
  }

  /**
   * Track `trackId`'s current pattern is about to change (called before the
   * engine switches). If it is the recording target, held notes end at
   * `ticksNow` in the old pattern and the next note-on starts a new take.
   */
  onPatternChanging(trackId: string, ticksNow: number) {
    if (this.#track?.id !== trackId) return;
    this.#closeAll(ticksNow);
    this.#newTarget();
  }

  noteOn(pitch: number, vel: number, perfMs: number, source = '') {
    if (!this.armed || !this.#playing || this.#song()) return;
    let tick = this.deps.clock.ticksForEvent(perfMs, this.#offsetMs);
    if (!(tick >= -GRACE_TICKS)) return; // count-in (or a NaN clock): not recorded
    if (tick < 0) tick = 0; // grace window
    if (!this.#track) {
      this.#track = this.deps.target();
      this.#pattern = this.#track && currentPattern(this.#track);
    }
    if (!this.#track) return; // no synth track to record into
    const key = `${source}:${pitch}`;
    // Same key re-struck while still open (pedal-held, or two QWERTY keys on
    // one pitch): the first note ends here.
    if (this.#open.has(key)) this.#close(key, tick);
    this.#open.set(key, { pitch, vel, tick, pedalHeld: false });
  }

  noteOff(pitch: number, perfMs: number, source = '') {
    const key = `${source}:${pitch}`;
    const o = this.#open.get(key);
    if (!o) return;
    if (this.#pedal.has(source)) o.pedalHeld = true; // ends at pedal-up
    else this.#close(key, this.deps.clock.ticksForEvent(perfMs, this.#offsetMs));
  }

  /** Sustain pedal of `source` (engine SUSTAIN is sent by the input itself). */
  sustain(on: boolean, perfMs: number, source = '') {
    if (on) {
      this.#pedal.add(source);
      return;
    }
    if (!this.#pedal.delete(source)) return;
    const prefix = `${source}:`;
    const held = [...this.#open].filter(([k, o]) => o.pedalHeld && k.startsWith(prefix));
    if (!held.length) return;
    const tick = this.deps.clock.ticksForEvent(perfMs, this.#offsetMs);
    for (const [k] of held) this.#close(k, tick);
  }

  /** Close one input's open notes at the heard tick now and forget its pedal (panic, unplug). */
  closeSource(source: string) {
    this.#pedal.delete(source);
    const now = this.deps.clock.heardTicks();
    for (const key of [...this.#open.keys()]) {
      if (key.startsWith(`${source}:`)) this.#close(key, now);
    }
  }

  undoLastTake() {
    // Captured first: selecting the take's pattern may close held notes into
    // a NEW take (onPatternChanging), which must survive this undo.
    const ids = this.lastTakeIds;
    const trackId = this.lastTakeTrackId;
    const patternId = this.lastTakePatternId;
    if (trackId && patternId && ids.length && this.#takeAlive()) {
      this.deps.deleteNotes(trackId, patternId, [...ids]);
    }
    if (this.lastTakeIds === ids) this.lastTakeIds = [];
    this.#takeStarted = false; // later notes in this pass form a new take
    this.#written.clear(); // and may be re-recorded at the same spots
  }

  /** True while notes played now would be recorded. */
  recording(): boolean {
    return this.armed && this.#playing && !this.#song() && this.deps.clock.heardTicks() >= 0;
  }

  status(): RecStatus {
    let state: RecState = this.armed ? 'armed' : 'off';
    if (this.armed && this.#playing && !this.#song()) {
      // Negative heard ticks without a count-in are just output latency after Play.
      state = this.deps.clock.heardTicks() >= 0 ? 'recording' : this.countIn ? 'count-in' : 'armed';
    }
    return { armed: this.armed, state, takeNotes: this.#takeAlive() ? this.lastTakeIds.length : 0 };
  }

  /** The last take's track and pattern still exist. */
  #takeAlive(): boolean {
    const t = this.lastTakeTrackId;
    const pat = this.lastTakePatternId;
    return !!t && !!pat && (this.deps.patternExists?.(t, pat) ?? true);
  }

  #beginPass() {
    this.#open.clear();
    this.#written.clear();
    this.#newTarget();
  }

  /** Forget the target; the next recorded note-on picks one and starts a new take. */
  #newTarget() {
    this.#track = null;
    this.#pattern = null;
    this.#takeStarted = false;
    this.#fullReported = false;
  }

  #closeAll(endTick: number) {
    for (const key of [...this.#open.keys()]) this.#close(key, endTick);
  }

  #close(key: string, endTick: number) {
    const o = this.#open.get(key)!;
    this.#open.delete(key);
    const t = this.#track;
    const pat = this.#pattern;
    if (!t || !pat || !Number.isFinite(endTick)) return;
    const period = pat.bars * BAR_TICKS;
    const startAbs = Math.round(o.tick);
    const start = mod(startAbs, period);
    // Negative (jitter between the two timestamp mappings) -> 1.
    const len = Math.min(period, Math.max(1, Math.round(endTick) - startAbs));
    const dup = `${t.id}:${pat.id}:${o.pitch}:${start}`;
    if (this.#written.has(dup)) return;
    const n = this.deps.addNote(t.id, pat.id, { pitch: o.pitch, start, len, vel: o.vel });
    if (!n) {
      // Null is also "track was removed mid-pass": only a full pattern is reported.
      if (!this.#fullReported && pat.notes.length >= MAX_NOTES) {
        this.#fullReported = true;
        this.deps.onFull?.();
      }
      return;
    }
    this.#written.add(dup);
    if (!this.#takeStarted) {
      this.#takeStarted = true;
      this.lastTakeIds = [];
      this.lastTakeTrackId = t.id;
      this.lastTakePatternId = pat.id;
    }
    this.lastTakeIds.push(n.id);
  }
}

/**
 * App's per-frame (60 Hz) sync of the recorder with the engine's telemetry
 * `playing` flag; returns the step to call each frame. A UI Play/Stop tells the
 * recorder directly (no frame of lag); this is the safety net for transport
 * changes the UI did not make (console, engine failure), and is idempotent
 * with the direct calls.
 * - Start: taken when the engine plays and the UI agrees (`uiPlaying` guards
 *   the frames between a UI Stop and the engine applying it).
 * - Stop: closes held notes at the last heard tick seen while playing (STOP
 *   resets the playhead to 0). Only once the engine has confirmed this pass:
 *   right after a UI Play the engine may not have applied PLAY yet, and that
 *   must not end the pass the UI just started.
 */
export function transportSync(r: Recorder) {
  let lastHeard = 0;
  let confirmed = false; // engine reported playing during the recorder's current pass
  return (enginePlaying: boolean, uiPlaying: boolean, heardTicks: () => number) => {
    if (enginePlaying) lastHeard = heardTicks();
    if (enginePlaying && uiPlaying && !r.playing) r.onTransport(true, lastHeard);
    else if (!enginePlaying && r.playing && (confirmed || !uiPlaying)) r.onTransport(false, lastHeard);
    confirmed = r.playing && (confirmed || enginePlaying);
  };
}

/** A Recorder wired to the real project, engine sink and clock. */
export function recorderFor(p: Project, sink: CommandSink, clock: RecorderClock, onFull?: () => void): Recorder {
  return new Recorder({
    clock,
    target: () => liveInputTrack(p),
    addNote: (trackId, patternId, o) => addNote(p, sink, trackId, o, patternId),
    deleteNotes: (trackId, patternId, ids) => {
      // Visible switch to the take's pattern (selectPattern is the only
      // switcher); unknown track/pattern: nothing to delete.
      if (selectPattern(p, sink, trackId, patternId)) deleteNotes(p, sink, trackId, ids, patternId);
    },
    patternExists: (trackId, patternId) => {
      const t = synthTrack(p, trackId);
      return !!t && !!patternOf(t, patternId);
    },
    songMode: () => p.mode === 'song',
    onFull,
  });
}

// ---- persisted settings (count-in, rec offset) -----------------------------

export interface RecSettings {
  countIn: boolean;
  offsetMs: number;
}

type StoreLike = Pick<Storage, 'getItem' | 'setItem'>;
const KEY_COUNT_IN = 'daw.countIn';
const KEY_OFFSET = 'daw.recOffsetMs';
const defaultStore = (): StoreLike | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
};

/** Defaults: count-in off, offset 0. Never throws. */
export function loadRecSettings(store: StoreLike | null = defaultStore()): RecSettings {
  const out: RecSettings = { countIn: false, offsetMs: 0 };
  try {
    out.countIn = store?.getItem(KEY_COUNT_IN) === '1';
    const n = Number(store?.getItem(KEY_OFFSET) ?? 0);
    out.offsetMs = Number.isFinite(n) ? Math.min(REC_OFFSET_MAX, Math.max(REC_OFFSET_MIN, Math.round(n))) : 0;
  } catch {
    return { countIn: false, offsetMs: 0 };
  }
  return out;
}

export function saveRecSettings(s: RecSettings, store: StoreLike | null = defaultStore()) {
  try {
    store?.setItem(KEY_COUNT_IN, s.countIn ? '1' : '0');
    store?.setItem(KEY_OFFSET, String(s.offsetMs));
  } catch {
    // Private mode / blocked storage: settings just don't persist.
  }
}
