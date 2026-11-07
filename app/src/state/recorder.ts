// Live recording of played notes into the live-input synth track's pattern.
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
// - Ticks are absolute transport ticks (monotonic while playing); a note's
//   pattern start is mod(tick, period), its length endTick - startTick, so a
//   note held across the loop end gets end + period - start. Clamped 1..period.
// - The note is written (addNote) on release. Notes still held when recording
//   becomes inactive (stop, disarm) close at that moment's heard tick.
// - The target track is captured at the first recorded note-on of the pass
//   and kept for the whole pass, even if another track gets selected.
// - Overdub: notes merge into the pattern; the same pitch at the same start
//   twice in one pass is written once.
// - A *take* is the notes one pass added; undoLastTake() removes exactly those.
//   An empty pass does not replace the previous take.
import { BAR_TICKS, MAX_NOTES } from '../audio/protocol';
import { mod } from '../audio/audioClock';
import { liveInputTrack } from './actions';
import type { CommandSink } from './actions';
import { addNote, deleteNotes, patternTicks } from './pattern-actions';
import type { Project, SynthTrack } from './project.svelte';
import type { NoteListener } from '../input/noteInput';

export const REC_OFFSET_MIN = -200;
export const REC_OFFSET_MAX = 200;

/** The slice of AudioClock the recorder uses. */
export interface RecorderClock {
  heardTicks(): number;
  ticksForEvent(perfMs: number, offsetMs: number): number;
}

export interface RecorderDeps {
  clock: RecorderClock;
  /** Track that would receive a recording now (the live-input synth). */
  target(): SynthTrack | null;
  addNote(trackId: string, o: { pitch: number; start: number; len: number; vel: number }): { id: string } | null;
  deleteNotes(trackId: string, ids: string[]): void;
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
}

export class Recorder implements NoteListener {
  armed = false;
  /** Count-in on Play while armed (one bar). The UI persists it. */
  countIn = false;
  /** Ids of the notes the last take added (on lastTakeTrackId). */
  lastTakeIds: string[] = [];
  lastTakeTrackId: string | null = null;

  #offsetMs = 0;
  #playing = false;
  /** Pass state. */
  #track: SynthTrack | null = null;
  #takeStarted = false;
  #written = new Set<string>(); // `${pitch}:${start}` written this pass
  #fullReported = false;
  /** Open (held, recording) notes by `${source}:${pitch}`. */
  #open = new Map<string, Open>();

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
    return this.armed && this.countIn ? BAR_TICKS : 0;
  }

  toggleArm() {
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

  noteOn(pitch: number, vel: number, perfMs: number, source = '') {
    if (!this.armed || !this.#playing) return;
    const tick = this.deps.clock.ticksForEvent(perfMs, this.#offsetMs);
    if (!(tick >= 0)) return; // count-in (or a NaN clock): not recorded
    if (!this.#track) this.#track = this.deps.target();
    if (!this.#track) return; // no synth track to record into
    const key = `${source}:${pitch}`;
    // Same key re-struck without a release (two QWERTY keys on one pitch): close the first.
    if (this.#open.has(key)) this.#close(key, tick);
    this.#open.set(key, { pitch, vel, tick });
  }

  noteOff(pitch: number, perfMs: number, source = '') {
    const key = `${source}:${pitch}`;
    if (!this.#open.has(key)) return;
    this.#close(key, this.deps.clock.ticksForEvent(perfMs, this.#offsetMs));
  }

  /** Close one input's open notes at the heard tick now (panic, unplug). */
  closeSource(source: string) {
    const now = this.deps.clock.heardTicks();
    for (const key of [...this.#open.keys()]) {
      if (key.startsWith(`${source}:`)) this.#close(key, now);
    }
  }

  undoLastTake() {
    if (this.lastTakeTrackId && this.lastTakeIds.length) {
      this.deps.deleteNotes(this.lastTakeTrackId, this.lastTakeIds);
    }
    this.lastTakeIds = [];
    this.#takeStarted = false; // later notes in this pass form a new take
    this.#written.clear(); // and may be re-recorded at the same spots
  }

  /** True while notes played now would be recorded. */
  recording(): boolean {
    return this.armed && this.#playing && this.deps.clock.heardTicks() >= 0;
  }

  status(): RecStatus {
    let state: RecState = this.armed ? 'armed' : 'off';
    if (this.armed && this.#playing) {
      // Negative heard ticks without a count-in are just output latency after Play.
      state = this.deps.clock.heardTicks() >= 0 ? 'recording' : this.countIn ? 'count-in' : 'armed';
    }
    return { armed: this.armed, state, takeNotes: this.lastTakeIds.length };
  }

  #beginPass() {
    this.#open.clear();
    this.#track = null;
    this.#takeStarted = false;
    this.#written.clear();
    this.#fullReported = false;
  }

  #closeAll(endTick: number) {
    for (const key of [...this.#open.keys()]) this.#close(key, endTick);
  }

  #close(key: string, endTick: number) {
    const o = this.#open.get(key)!;
    this.#open.delete(key);
    const t = this.#track;
    if (!t || !Number.isFinite(endTick)) return;
    const period = patternTicks(t);
    const startAbs = Math.round(o.tick);
    const start = mod(startAbs, period);
    let len = Math.round(endTick) - startAbs;
    // Absolute ticks are monotonic while playing; if not (transport jumped),
    // fall back to the modular distance.
    if (len < 0) len = mod(Math.round(endTick) - startAbs, period);
    len = Math.min(period, Math.max(1, len));
    const dup = `${o.pitch}:${start}`;
    if (this.#written.has(dup)) return;
    const n = this.deps.addNote(t.id, { pitch: o.pitch, start, len, vel: o.vel });
    if (!n) {
      // Null is also "track was removed mid-pass": only a full pattern is reported.
      if (!this.#fullReported && t.pattern.notes.length >= MAX_NOTES) {
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
    }
    this.lastTakeIds.push(n.id);
  }
}

/** A Recorder wired to the real project, engine sink and clock. */
export function recorderFor(p: Project, sink: CommandSink, clock: RecorderClock, onFull?: () => void): Recorder {
  return new Recorder({
    clock,
    target: () => liveInputTrack(p),
    addNote: (trackId, o) => addNote(p, sink, trackId, o),
    deleteNotes: (trackId, ids) => deleteNotes(p, sink, trackId, ids),
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
