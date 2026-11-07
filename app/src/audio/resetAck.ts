// Waiting for the worklet to confirm an OP_RESET_ALL.
//
// Why: RESET_ALL travels through the command ring (drained at the start of
// the next process() call), but sample uploads go by postMessage and are
// handled between render quanta. An upload posted right after RESET_ALL can
// therefore land *before* the reset, load into the old session and then be
// wiped by it. So the worklet posts {type:'reset-done', code} once it has
// applied a RESET_ALL, and a project load awaits that before any loadSample
// (AudioEngine.resetAll, project/load.ts).
//
// Acks come back in the order the resets were sent. A waiter that timed out
// keeps its place in the queue, so its late ack is consumed by it and never
// resolves the next waiter.

interface Waiter {
  resolve: (code: number) => void;
  dead: boolean;
}

export class ResetAcks {
  private readonly queue: Waiter[] = [];

  /** Resolves with the RESET_ALL result code; rejects after `timeoutMs` without an ack. */
  wait(timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { resolve: () => {}, dead: false };
      const timer = setTimeout(() => {
        w.dead = true;
        reject(new Error('The audio engine did not confirm the reset (is the audio context suspended?)'));
      }, timeoutMs);
      w.resolve = (code) => {
        clearTimeout(timer);
        resolve(code);
      };
      this.queue.push(w);
    });
  }

  /** The worklet's 'reset-done' for the oldest outstanding reset. */
  ack(code: number): void {
    const w = this.queue.shift();
    if (w && !w.dead) w.resolve(code);
  }

  /** Settle every waiter with `code` (the engine stopped; no ack will come). */
  failAll(code: number): void {
    for (const w of this.queue.splice(0)) if (!w.dead) w.resolve(code);
  }
}
