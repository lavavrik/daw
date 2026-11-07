import { describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS, createIdleDriver } from './idleDriver';
import { createVisWake } from './visWake';
import type { FrameConsumer } from './frameLoop';

/** A frame loop stand-in: the registered consumers, run by hand at a clock. */
function fakeLoop() {
  const consumers = new Set<FrameConsumer>();
  let t = 0;
  return {
    consumers,
    add(c: FrameConsumer) {
      consumers.add(c);
      return () => void consumers.delete(c);
    },
    /** Frames every `dt` ms for `ms`. */
    run(ms: number, dt = 1000 / 30) {
      for (let e = 0; e < ms; e += dt) {
        t += dt;
        for (const c of [...consumers]) c.frame(t, {} as never);
      }
    },
  };
}

describe('idleDriver', () => {
  it('stopped and silent for 0.5 s removes the consumer; a kick re-adds it', () => {
    const loop = fakeLoop();
    const wake = createVisWake();
    let lit = true;
    let frames = 0;
    const d = createIdleDriver({
      loop, want: 4, hz: 30, el: null, wake,
      frame: () => (frames++, lit),
    });
    d.kick();
    d.kick(); // once only
    expect(loop.consumers.size).toBe(1);
    expect([...loop.consumers][0].want).toBe(4);
    expect([...loop.consumers][0].hz).toBe(30);
    loop.run(2000); // lit: stays
    expect(loop.consumers.size).toBe(1);
    lit = false;
    loop.run(IDLE_AFTER_MS - 100); // dark, but not for long enough
    expect(loop.consumers.size).toBe(1);
    loop.run(200);
    expect(loop.consumers.size).toBe(0);
    expect(d.running).toBe(false);
    const before = frames;
    loop.run(1000);
    expect(frames).toBe(before); // asleep: no frames at all
    d.kick();
    expect(loop.consumers.size).toBe(1);
    // A fresh kick gets a whole quiet period again.
    loop.run(IDLE_AFTER_MS - 100);
    expect(loop.consumers.size).toBe(1);
    d.stop();
    expect(loop.consumers.size).toBe(0);
    d.kick(); // stopped for good (unmounted)
    expect(loop.consumers.size).toBe(0);
  });

  it('stays while the transport plays, and play or a note wakes it', () => {
    const loop = fakeLoop();
    const wake = createVisWake();
    const d = createIdleDriver({ loop, want: 4, el: null, wake, frame: () => false });
    d.kick();
    wake.setPlaying(true);
    loop.run(3000);
    expect(loop.consumers.size).toBe(1); // dark but playing
    wake.setPlaying(false);
    loop.run(IDLE_AFTER_MS + 100);
    expect(loop.consumers.size).toBe(0);
    wake.setPlaying(true); // Play
    expect(loop.consumers.size).toBe(1);
    wake.setPlaying(false);
    loop.run(IDLE_AFTER_MS + 100);
    expect(loop.consumers.size).toBe(0);
    wake.wake(); // a note-on
    expect(loop.consumers.size).toBe(1);
    d.stop();
    wake.wake();
    expect(loop.consumers.size).toBe(0);
  });
});
