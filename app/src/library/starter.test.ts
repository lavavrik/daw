import { describe, expect, it } from 'vitest';
import { STARTER_KIT, starterSample } from './starter';

const kit = { name: 'Starter kit', files: [{ path: 'kick-punch.wav', url: '/s/kick-punch.wav' }] };
const fetchBytes = async (url: string) => (url === '/s/kick-punch.wav' ? new Uint8Array([9, 9]).buffer : Promise.reject(new Error('HTTP 404')));

describe('starter kit (built in, plan 8 Task 4)', () => {
  it('is bundled from samples/starter/ (the default kit needs these files)', () => {
    const names = STARTER_KIT.files.map((f) => f.path);
    for (const f of ['kick-punch.wav', 'clap.wav', 'hat-closed.wav', 'hat-open.wav', 'snare.wav', 'rim.wav', 'shaker.wav', 'perc-tom.wav']) {
      expect(names).toContain(f);
    }
  });

  it('starterSample fetches a kit file as a File (name, audio type, bytes)', async () => {
    const f = await starterSample('kick-punch.wav', kit, fetchBytes);
    expect([f.name, f.type]).toEqual(['kick-punch.wav', 'audio/wav']);
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
  });

  it('an unknown name or a failed fetch rejects with a message naming the file', async () => {
    await expect(starterSample('nope.wav', kit, fetchBytes)).rejects.toThrow('"nope.wav" is not in the starter kit');
    await expect(starterSample('kick-punch.wav', { ...kit, files: [{ path: 'kick-punch.wav', url: '/gone' }] }, fetchBytes)).rejects.toThrow('HTTP 404');
  });
});
