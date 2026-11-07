import { describe, expect, it } from 'vitest';
import { createWaveDriver } from './waveDriver';
import type { FrameConsumer } from './frameLoop';

/** A frame loop stand-in: the registered consumers, run by hand. */
function fakeLoop() {
  const consumers = new Set<FrameConsumer>();
  return {
    consumers,
    add(c: FrameConsumer) {
      consumers.add(c);
      return () => consumers.delete(c);
    },
    run() {
      for (const c of [...consumers]) c.frame(0, {} as never);
    },
  };
}

describe('waveDriver', () => {
  it('registers only while there is work: stopped and idle means no consumer', () => {
    const loop = fakeLoop();
    let dirty = false;
    let live = false;
    let frames = 0;
    const d = createWaveDriver({
      loop, el: {} as Element,
      frame: () => {
        frames++;
        dirty = false;
      },
      idle: () => !dirty && !live,
    });
    expect(loop.consumers.size).toBe(0);
    dirty = true;
    d.kick();
    d.kick(); // once only
    expect(loop.consumers.size).toBe(1);
    loop.run(); // draws, then nothing is left to do
    expect(frames).toBe(1);
    expect(loop.consumers.size).toBe(0);
    // Playing: it stays for the playhead until playback stops.
    live = true;
    d.kick();
    loop.run();
    loop.run();
    expect(loop.consumers.size).toBe(1);
    live = false;
    loop.run(); // the last frame hides the playhead, then it leaves
    expect(frames).toBe(4);
    expect(loop.consumers.size).toBe(0);
    // Unmount removes it whatever its state.
    live = true;
    d.kick();
    d.stop();
    expect(loop.consumers.size).toBe(0);
    d.kick(); // stopped: never again
    expect(loop.consumers.size).toBe(0);
  });
});
