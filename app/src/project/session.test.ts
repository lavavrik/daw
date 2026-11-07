import { beforeEach, describe, expect, it } from 'vitest';
import { banners } from '../state/banners.svelte';
import { Project } from '../state/project.svelte';
import { createProjectSession } from './session';
import { FakeDir, asDir } from './fakeDir';
import { buildFixture, fakeDecoder, fakeEngine } from './testFixture';

const engine = () => Object.assign(fakeEngine(), { context: fakeDecoder });

describe('project session', () => {
  beforeEach(() => {
    banners.error = banners.notice = banners.load = null;
    banners.ask = null;
  });

  it('Save As into a folder that holds a project asks inline first (fix 2)', async () => {
    const { p } = buildFixture();
    const dir = new FakeDir('Library');
    dir.put('project.json', '{"schemaVersion":1}');
    const s = createProjectSession(p, engine(), { pick: async () => asDir(dir) });
    await s.saveAs();
    expect(dir.log).toEqual([]); // nothing written yet
    expect(p.folder).toBeNull();
    expect(banners.ask?.text).toMatch(/Replace the project in "Library"/);
    await banners.ask!.run();
    expect(banners.ask).toBeNull();
    expect(dir.log).toContain('move project.json.tmp -> project.json');
    expect(p.folder).toBe(dir);
    expect(p.name).toBe('Library');
  });

  it('Save As into an empty folder, or the current one, saves at once', async () => {
    const { p } = buildFixture();
    const empty = new FakeDir('New Song');
    const s = createProjectSession(p, engine(), { pick: async () => asDir(empty) });
    await s.saveAs();
    expect(banners.ask).toBeNull();
    expect(empty.log).toContain('move project.json.tmp -> project.json');
    await s.saveAs(); // same folder again: it is ours
    expect(banners.ask).toBeNull();
  });

  it('a non-empty samples/ also counts as in use; Cancel writes nothing', async () => {
    const { p } = buildFixture();
    const dir = new FakeDir('Kits');
    (await dir.getDirectoryHandle('samples', { create: true })).put('kick.wav', [1]);
    const s = createProjectSession(p, engine(), { pick: async () => asDir(dir) });
    await s.saveAs();
    expect(banners.ask).not.toBeNull();
    banners.ask = null; // Cancel
    expect(dir.log).toEqual([]);
  });

  it('load warnings get their own banner; beforeLoad / afterLoad run (fixes 8, 10)', async () => {
    const { p: src } = buildFixture();
    const dir = new FakeDir('Song');
    await createProjectSession(src, engine()).saveTo(asDir(dir));
    // Remove one sample file so the load warns.
    const samples = await dir.getDirectoryHandle('samples');
    await samples.removeEntry([...samples.files.keys()][0]);
    const calls: string[] = [];
    const p = new Project();
    const s = createProjectSession(p, engine(), { beforeLoad: () => calls.push('before'), afterLoad: () => calls.push('after') });
    banners.notice = '"x" will load when playback stops';
    const warnings = await s.openFrom(asDir(dir));
    expect(warnings).toHaveLength(1);
    expect(banners.load).toMatch(/kick\.wav/);
    expect(banners.notice).toBe('"x" will load when playback stops'); // untouched
    expect(calls).toEqual(['before', 'after']);
    expect(p.folder).toBe(dir);
  });

  it('a load that fails after the reset still runs afterLoad and leaves no folder', async () => {
    const { p: src } = buildFixture();
    const dir = new FakeDir('Song');
    await createProjectSession(src, engine()).saveTo(asDir(dir));
    const p = new Project();
    p.folder = asDir(new FakeDir('Old'));
    const e = Object.assign(fakeEngine(), { context: fakeDecoder, resetAll: async () => -3 });
    const calls: string[] = [];
    const s = createProjectSession(p, e, { afterLoad: () => calls.push('after') });
    await expect(s.openFrom(asDir(dir))).rejects.toThrow(/refused/);
    expect(calls).toEqual(['after']);
    expect(p.folder).toBeNull();
  });
});
