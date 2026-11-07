import { describe, expect, it } from 'vitest';
import { folderInUse, readProject, writeProject } from './fsFolder';
import { FakeDir, asDir, bytes } from './fakeDir';

const json1 = { schemaVersion: 1, name: 'A', samples: [{ id: 0, file: 'samples/0-kick.wav' }] };

describe('fsFolder', () => {
  it('writeProject writes samples, then project.json.tmp, then project.json', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1, 2, 3)]]));
    expect(dir.log).toEqual(['write samples/0-kick.wav', 'write project.json.tmp', 'move project.json.tmp -> project.json']);
    const back = await readProject(asDir(dir));
    expect(back.json).toEqual(json1);
    expect([...back.files.keys()]).toEqual(['samples/0-kick.wav']);
    expect(new Uint8Array(back.files.get('samples/0-kick.wav')!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('copies when the handle cannot move, and removes stale samples last', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    dir.log = [];
    dir.noMove = true;
    const json2 = { schemaVersion: 1, name: 'B', samples: [{ id: 0, file: 'samples/0-snare.wav' }] };
    const noMove = new Map([['samples/0-snare.wav', bytes(2)]]);
    await writeProject(asDir(dir), json2, noMove);
    expect(dir.log).toEqual([
      'write samples/0-snare.wav', 'write project.json.tmp', 'write project.json', 'remove project.json.tmp',
      'remove samples/0-kick.wav',
    ]);
    expect((await readProject(asDir(dir))).json).toEqual(json2);
  });

  it('an interrupted write leaves the previous project readable', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    dir.failOn = '1-hat.wav';
    const json2 = { schemaVersion: 1, name: 'B', samples: [{ id: 1, file: 'samples/1-hat.wav' }] };
    await expect(writeProject(asDir(dir), json2, new Map([['samples/1-hat.wav', bytes(9)]]))).rejects.toThrow(/disk full/);
    const back = await readProject(asDir(dir));
    expect(back.json).toEqual(json1);
    expect(back.files.has('samples/0-kick.wav')).toBe(true);
  });

  it('readProject explains a folder without a project', async () => {
    await expect(readProject(asDir(new FakeDir()))).rejects.toThrow(/project\.json/);
    const dir = new FakeDir();
    const f = await dir.getFileHandle('project.json', { create: true });
    const w = await f.createWritable();
    await w.write('{nope');
    await w.close();
    await expect(readProject(asDir(dir))).rejects.toThrow(/not valid JSON/);
  });

  it('never removes files the previous project did not list (fix 2)', async () => {
    const dir = new FakeDir();
    const samples = await dir.getDirectoryHandle('samples', { create: true });
    samples.put('my-library-kick.wav', [7, 7]); // the user's own file, no project here
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    expect(samples.files.has('my-library-kick.wav')).toBe(true);
    // Saving again with other samples removes only what project.json listed.
    const json2 = { schemaVersion: 1, name: 'B', samples: [{ id: 0, file: 'samples/0-snare.wav' }] };
    await writeProject(asDir(dir), json2, new Map([['samples/0-snare.wav', bytes(2)]]));
    expect([...samples.files.keys()].sort()).toEqual(['0-snare.wav', 'my-library-kick.wav']);
  });

  it('folderInUse: a project.json or a non-empty samples/ (fix 2)', async () => {
    expect(await folderInUse(asDir(new FakeDir()))).toBe(false);
    const a = new FakeDir();
    await a.getDirectoryHandle('samples', { create: true });
    expect(await folderInUse(asDir(a))).toBe(false);
    (await a.getDirectoryHandle('samples')).put('x.wav', [1]);
    expect(await folderInUse(asDir(a))).toBe(true);
    const b = new FakeDir();
    b.put('project.json', '{}');
    expect(await folderInUse(asDir(b))).toBe(true);
  });

  it('readProject reads only the samples project.json lists (fix 6)', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    (await dir.getDirectoryHandle('samples')).put('huge-unrelated.wav', [1, 2, 3]);
    const back = await readProject(asDir(dir));
    expect([...back.files.keys()]).toEqual(['samples/0-kick.wav']);
  });
});
