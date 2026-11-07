// Ordered, never-dropping front end for the command ring.
//
// The SAB ring holds RING_CAPACITY - 1 = 1023 records and the worklet drains it
// once per 128-frame block (~2.7 ms). A bulk edit (delete / quantize / undo a
// take over ~1000 notes, plan 4's duplicate) can send more than that in one
// task. Dropping the overflow would leave the engine out of step with the UI
// state for good, so instead:
//
// - send() pushes straight into the ring while nothing is waiting; otherwise
//   (ring full, or a backlog already exists) the record joins a main-thread
//   FIFO backlog. A new send never overtakes the backlog: order is preserved.
// - A scheduled flush (setTimeout 0 in the app) moves backlog records into the
//   ring as the worklet frees space, and re-arms itself until the backlog is
//   empty.
// - If the backlog has existed for more than STALL_MS (the audio thread is not
//   draining: suspended context, a stuck worklet) or grows past BACKLOG_LIMIT,
//   onStall(message) fires once; onStall(null) fires when it drains again.
//   Nothing is dropped either way.
//
// Pure (ring push, scheduler and clock injected), so it is unit-tested with a
// fake ring; AudioEngine wires the real ones. See docs/architecture/audio-path.md.

/** A backlog older than this means the audio thread is not keeping up. */
export const STALL_MS = 2000;
/** Waiting records beyond this are reported at once (64x the ring). */
export const BACKLOG_LIMIT = 65536;

export interface SenderDeps {
  /** Try to put one record into the ring; false when it is full. */
  push(op: number, a: number, b: number, c: number, d: number): boolean;
  /** Run `fn` soon, on the main thread (setTimeout 0). */
  schedule(fn: () => void): void;
  /** Milliseconds (performance.now). */
  now(): number;
  /** A stall began (message) or ended (null). */
  onStall?(message: string | null): void;
}

const W = 5; // words per record

export class CommandSender {
  /** Flat [op, a, b, c, d, op, …]; records before `#head` are already sent. */
  #q: number[] = [];
  #head = 0;
  #scheduled = false;
  /** now() when the backlog last went from empty to non-empty. */
  #since = 0;
  #stalled = false;

  private deps: SenderDeps;
  constructor(deps: SenderDeps) {
    this.deps = deps;
  }

  /** Records waiting for room in the ring. */
  get backlog(): number {
    return (this.#q.length - this.#head) / W;
  }

  /** Deliver a command after every earlier one. Never drops. */
  send(op: number, a = 0, b = 0, c = 0, d = 0): void {
    const empty = this.backlog === 0;
    if (empty && this.deps.push(op, a, b, c, d)) return;
    if (empty) this.#since = this.deps.now();
    this.#q.push(op, a, b, c, d);
    if (this.backlog > BACKLOG_LIMIT) this.#stall();
    this.#arm();
  }

  /** Move as much of the backlog into the ring as fits; re-arms if some is left. */
  flush(): void {
    this.#scheduled = false;
    const q = this.#q;
    while (this.#head < q.length) {
      const h = this.#head;
      if (!this.deps.push(q[h], q[h + 1], q[h + 2], q[h + 3], q[h + 4])) break;
      this.#head = h + W;
    }
    if (this.#head === q.length) {
      this.#q = [];
      this.#head = 0;
      if (this.#stalled) {
        this.#stalled = false;
        this.deps.onStall?.(null);
      }
      return;
    }
    if (this.#head > 4096 * W && this.#head * 2 > q.length) {
      this.#q = q.slice(this.#head); // keep memory bounded on long backlogs
      this.#head = 0;
    }
    if (this.deps.now() - this.#since > STALL_MS) this.#stall();
    this.#arm();
  }

  /** Forget the backlog (the engine stopped for good; nothing will drain it). */
  clear(): void {
    this.#q = [];
    this.#head = 0;
    this.#stalled = false;
  }

  #arm() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.deps.schedule(() => this.flush());
  }

  #stall() {
    if (this.#stalled) return;
    this.#stalled = true;
    this.deps.onStall?.(
      `The audio engine is not keeping up: ${this.backlog} commands are waiting (nothing was dropped)`,
    );
  }
}
