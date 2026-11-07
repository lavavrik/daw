import { describe, expect, it } from 'vitest';
import { FakeDir, asDir } from '../project/fakeDir';
import { isAudioName, patchFileName, scanLibrary, treeFromPaths } from './scan';

function lib() {
  const root = new FakeDir('My Sounds');
  root.put('kick.wav', [1]);
  root.put('notes.txt', 'hi');
  root.put('.DS_Store', [0]);
  root.put('Zap.FLAC', [1]);
  const drums = new FakeDir('drums', root);
  root.files.set('drums', drums);
  drums.put('snare.aif', [1]);
  drums.put('hat.MP3', [1]);
  drums.put('readme.md', 'x');
  const deep = new FakeDir('909', drums);
  drums.files.set('909', deep);
  deep.put('clap.ogg', [1]);
  const empty = new FakeDir('empty', root);
  root.files.set('empty', empty);
  empty.put('only.txt', 'x');
  const hidden = new FakeDir('.git', root);
  root.files.set('.git', hidden);
  hidden.put('x.wav', [1]);
  const patches = new FakeDir('patches', root);
  root.files.set('patches', patches);
  patches.put('Bass.json', '{}');
  patches.put('acid lead.json', '{}');
  patches.put('old.txt', 'x');
  patches.put('loop.wav', [1]); // audio in patches/ is not a sample folder
  const sub = new FakeDir('sub', patches);
  patches.files.set('sub', sub);
  sub.put('nested.json', '{}');
  return root;
}

describe('library scan', () => {
  it('scan lists audio + patches, ignores others', async () => {
    const t = await scanLibrary(asDir(lib()));
    expect(t.root.name).toBe('My Sounds');
    // Root samples, sorted case-insensitively; non-audio and hidden files are ignored.
    expect(t.root.samples).toEqual([
      { name: 'kick.wav', path: 'kick.wav' },
      { name: 'Zap.FLAC', path: 'Zap.FLAC' },
    ]);
    // Folders without audio anywhere below are pruned; hidden folders and patches/ are not sample folders.
    expect(t.root.folders.map((f) => f.name)).toEqual(['drums']);
    const drums = t.root.folders[0];
    expect(drums.path).toBe('drums');
    expect(drums.samples.map((s) => s.path)).toEqual(['drums/hat.MP3', 'drums/snare.aif']);
    expect(drums.folders.map((f) => [f.path, f.samples.map((s) => s.name)])).toEqual([['drums/909', ['clap.ogg']]]);
    // patches/*.json only (not nested), by name without the extension.
    expect(t.patches).toEqual([
      { name: 'acid lead', path: 'patches/acid lead.json' },
      { name: 'Bass', path: 'patches/Bass.json' },
    ]);
    expect(t.truncated).toBe(false);
  });

  it('stops at the entry cap and says so', async () => {
    const root = new FakeDir('big');
    for (let i = 0; i < 50; i++) root.put(`s${String(i).padStart(2, '0')}.wav`, [1]);
    const t = await scanLibrary(asDir(root), { maxEntries: 10 });
    expect(t.root.samples.length).toBeLessThanOrEqual(10);
    expect(t.truncated).toBe(true);
  });

  it('propagates access errors (the caller decides: reconnect)', async () => {
    const root = new FakeDir('gone');
    root.entries = async function* () {
      throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
    } as FakeDir['entries'];
    await expect(scanLibrary(asDir(root))).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('builds the same tree from a flat path list (starter kit)', () => {
    const t = treeFromPaths('Starter kit', ['snare.wav', 'kick.wav', 'LICENSE.txt']);
    expect(t.root.samples.map((s) => s.path)).toEqual(['kick.wav', 'snare.wav']);
    expect(t.root.folders).toEqual([]);
    expect(t.patches).toEqual([]);
  });

  it('knows the plan-1 audio extensions', () => {
    for (const n of ['a.wav', 'a.AIF', 'a.aiff', 'a.mp3', 'a.flac', 'a.ogg', 'a.m4a']) expect(isAudioName(n)).toBe(true);
    for (const n of ['a.txt', 'a.json', 'wav', 'a.wav.bak']) expect(isAudioName(n)).toBe(false);
  });

  it('patchFileName makes a safe file name or refuses', () => {
    expect(patchFileName('  Acid Lead ')).toBe('Acid Lead.json');
    expect(patchFileName('a/b:c*?"<>|d')).toBe('a b c d.json');
    expect(patchFileName('...')).toBeNull();
    expect(patchFileName('   ')).toBeNull();
    expect(patchFileName('x'.repeat(200))).toBe(`${'x'.repeat(64)}.json`);
  });
});
