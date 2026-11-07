import { describe, expect, it } from 'vitest';
import { FakeDir, asDir } from '../project/fakeDir';
import { isAudioName, listFolder, listPatches, listingFromPaths, patchFileName } from './scan';

function sub(parent: FakeDir, name: string) {
  const d = new FakeDir(name, parent);
  parent.files.set(name, d);
  return d;
}

function lib() {
  const root = new FakeDir('My Sounds');
  root.put('kick.wav', [1]);
  root.put('notes.txt', 'hi');
  root.put('.DS_Store', [0]);
  root.put('Zap.FLAC', [1]);
  const drums = sub(root, 'drums');
  drums.put('snare.aif', [1]);
  drums.put('hat.MP3', [1]);
  drums.put('readme.md', 'x');
  sub(drums, '909').put('clap.ogg', [1]);
  sub(root, 'Bass').put('sub.wav', [1]);
  sub(root, '.git').put('x.wav', [1]);
  const patches = sub(root, 'patches');
  patches.put('Bass.json', '{}');
  patches.put('acid lead.json', '{}');
  patches.put('old.txt', 'x');
  patches.put('loop.wav', [1]); // audio in patches/ is not a sample folder
  sub(patches, 'sub').put('nested.json', '{}');
  return root;
}

describe('library listing (one folder level at a time)', () => {
  it('scan lists audio + patches, ignores others', async () => {
    const root = asDir(lib());
    const top = await listFolder(root, '');
    // Root samples, sorted by name (case-insensitive); non-audio and hidden files are ignored.
    expect(top.samples).toEqual([
      { name: 'kick.wav', path: 'kick.wav' },
      { name: 'Zap.FLAC', path: 'Zap.FLAC' },
    ]);
    // Sub-folders by name; hidden folders and the root's patches/ are not sample folders.
    expect(top.folders).toEqual([
      { name: 'Bass', path: 'Bass' },
      { name: 'drums', path: 'drums' },
    ]);
    expect(top.more).toBe(0);
    // A folder is listed when it is opened: one level, its own paths.
    const drums = await listFolder(root, 'drums');
    expect(drums.samples.map((s) => s.path)).toEqual(['drums/hat.MP3', 'drums/snare.aif']);
    expect(drums.folders).toEqual([{ name: '909', path: 'drums/909' }]);
    expect((await listFolder(root, 'drums/909')).samples.map((s) => s.name)).toEqual(['clap.ogg']);
    // patches/*.json only (not nested), by name without the extension.
    expect(await listPatches(root)).toEqual([
      { name: 'acid lead', path: 'patches/acid lead.json' },
      { name: 'Bass', path: 'patches/Bass.json' },
    ]);
  });

  it('caps each folder by name order; non-audio entries never count', async () => {
    const root = new FakeDir('big');
    // Entries arrive in an arbitrary order; .asd files sit beside every sample (Ableton).
    for (const i of [7, 3, 9, 0, 5, 1, 8, 2, 6, 4]) {
      root.put(`s${i}.wav`, [1]);
      root.put(`s${i}.wav.asd`, [1]);
    }
    for (const i of [2, 0, 1]) sub(root, `d${i}`);
    const l = await listFolder(asDir(root), '', { maxEntries: 4 });
    expect(l.samples.map((s) => s.name)).toEqual(['s0.wav', 's1.wav', 's2.wav', 's3.wav']);
    expect(l.folders.map((f) => f.name)).toEqual(['d0', 'd1', 'd2']);
    expect(l.more).toBe(6); // 6 audio files not shown; the 10 .asd files are not counted
  });

  it('a missing folder or lost access propagates (the caller decides)', async () => {
    const root = new FakeDir('gone');
    await expect(listFolder(asDir(root), 'nope')).rejects.toMatchObject({ name: 'NotFoundError' });
    root.entries = async function* () {
      throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
    } as FakeDir['entries'];
    await expect(listFolder(asDir(root), '')).rejects.toMatchObject({ name: 'NotFoundError' });
    // No patches/ folder is simply no patches.
    expect(await listPatches(asDir(new FakeDir('x')))).toEqual([]);
  });

  it('builds a root listing from a flat path list (starter kit)', () => {
    const l = listingFromPaths(['snare.wav', 'kick.wav', 'LICENSE.txt']);
    expect(l.samples.map((s) => s.path)).toEqual(['kick.wav', 'snare.wav']);
    expect(l.folders).toEqual([]);
    expect(l.more).toBe(0);
  });

  it('knows the plan-1 audio extensions', () => {
    for (const n of ['a.wav', 'a.AIF', 'a.aiff', 'a.mp3', 'a.flac', 'a.ogg', 'a.m4a']) expect(isAudioName(n)).toBe(true);
    for (const n of ['a.txt', 'a.json', 'wav', 'a.wav.bak', 'a.wav.asd']) expect(isAudioName(n)).toBe(false);
  });

  it('patchFileName makes a safe file name or refuses', () => {
    expect(patchFileName('  Acid Lead ')).toBe('Acid Lead.json');
    expect(patchFileName('a/b:c*?"<>|d')).toBe('a b c d.json');
    expect(patchFileName('...')).toBeNull();
    expect(patchFileName('   ')).toBeNull();
    expect(patchFileName('x'.repeat(200))).toBe(`${'x'.repeat(64)}.json`);
  });
});
