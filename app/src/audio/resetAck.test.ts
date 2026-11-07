import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResetAcks } from './resetAck';

describe('ResetAcks', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves waiters in order with the worklet codes', async () => {
    const r = new ResetAcks();
    const a = r.wait(2000);
    const b = r.wait(2000);
    r.ack(0);
    r.ack(-3);
    await expect(a).resolves.toBe(0);
    await expect(b).resolves.toBe(-3);
  });

  it('rejects after the timeout; a late ack does not resolve the next waiter', async () => {
    vi.useFakeTimers();
    const r = new ResetAcks();
    const a = r.wait(2000);
    const caught = a.catch((e: Error) => e.message);
    vi.advanceTimersByTime(2001);
    expect(await caught).toMatch(/did not confirm/);
    const b = r.wait(2000);
    r.ack(0); // the late ack of `a`
    let settled = false;
    void b.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    r.ack(0);
    await expect(b).resolves.toBe(0);
  });

  it('failAll settles every waiter', async () => {
    const r = new ResetAcks();
    const a = r.wait(2000);
    r.failAll(-100);
    await expect(a).resolves.toBe(-100);
  });
});
