import { describe, expect, it } from 'vitest';
import { BACKLOG_LIMIT, CommandSender, STALL_MS } from './sendQueue';

/**
 * A ring of `cap - 1` usable records (like CommandRing) that the "audio
 * thread" empties on block(); timers run on tick(); time is set by hand.
 */
function harness(cap = 8) {
  const ring: number[][] = [];
  const got: number[][] = [];
  const timers: (() => void)[] = [];
  const stalls: (string | null)[] = [];
  const h = {
    now: 0,
    ring,
    got,
    stalls,
    pending: () => timers.length,
    sender: new CommandSender({
      push: (op, a, b, c, d) => {
        if (ring.length >= cap - 1) return false;
        ring.push([op, a, b, c, d]);
        return true;
      },
      schedule: (fn) => void timers.push(fn),
      now: () => h.now,
      onStall: (m) => stalls.push(m),
    }),
    /** One audio block: the worklet drains everything queued. */
    block: () => got.push(...ring.splice(0)),
    /** Run the timers due now. */
    tick: () => timers.splice(0).forEach((f) => f()),
  };
  return h;
}

describe('CommandSender', () => {
  it('3000 sends through a small ring all arrive, in order', () => {
    const h = harness(8);
    for (let i = 0; i < 3000; i++) h.sender.send(i, i + 1, i + 2, i + 3, i + 4);
    expect(h.sender.backlog).toBe(3000 - 7);
    let guard = 0;
    while (h.sender.backlog > 0 && guard++ < 10_000) {
      h.block();
      h.tick();
    }
    h.block();
    expect(h.got).toHaveLength(3000);
    expect(h.got.every((r, i) => r.join() === [i, i + 1, i + 2, i + 3, i + 4].join())).toBe(true);
    expect(h.pending()).toBe(0); // the retry loop stops once drained
    expect(h.stalls).toEqual([]);
  });

  it('a new send queues behind a non-empty backlog even when the ring has room', () => {
    const h = harness(4);
    for (let i = 0; i < 5; i++) h.sender.send(i);
    h.block(); // ring empty, backlog [3, 4] not flushed yet
    h.sender.send(5); // must not overtake 3 and 4
    h.tick();
    h.block();
    h.tick();
    h.block();
    expect(h.got.map((r) => r[0])).toEqual([0, 1, 2, 3, 4, 5]);
    // Backlog empty again: sends go straight to the ring.
    h.sender.send(6);
    expect(h.ring.map((r) => r[0])).toEqual([6]);
    expect(h.pending()).toBe(0);
  });

  it('a ring that stays full for > STALL_MS reports a stall once, and recovery', () => {
    const h = harness(4);
    for (let i = 0; i < 10; i++) h.sender.send(i);
    h.now = STALL_MS - 1;
    h.tick();
    expect(h.stalls).toEqual([]);
    h.now = STALL_MS + 1;
    h.tick();
    h.now += 1000;
    h.tick();
    expect(h.stalls).toHaveLength(1);
    expect(h.stalls[0]).toMatch(/audio engine/i);
    while (h.sender.backlog > 0) {
      h.block();
      h.tick();
    }
    expect(h.stalls).toEqual([h.stalls[0], null]);
  });

  it('a backlog over BACKLOG_LIMIT reports a stall at once (nothing is dropped)', () => {
    const h = harness(4);
    for (let i = 0; i < BACKLOG_LIMIT + 3 + 1; i++) h.sender.send(i);
    expect(h.stalls).toHaveLength(1);
    expect(h.sender.backlog).toBe(BACKLOG_LIMIT + 1);
  });

  it('clear() drops the backlog and stops retrying (engine stopped for good)', () => {
    const h = harness(4);
    for (let i = 0; i < 10; i++) h.sender.send(i);
    h.sender.clear();
    expect(h.sender.backlog).toBe(0);
    h.block();
    h.tick();
    expect(h.got.map((r) => r[0])).toEqual([0, 1, 2]);
    expect(h.pending()).toBe(0);
  });
});
