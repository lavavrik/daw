import { beforeEach, describe, expect, it } from 'vitest';
import { banners } from '../state/banners.svelte';
import { Project } from '../state/project.svelte';
import { createProjectSession } from './session';
import { commandEdits, markEdited } from '../state/edits';
import { projectFiles, projectFingerprint, serialize } from './serialize';
import { FakeDir, asDir } from './fakeDir';
import { buildFixture, fakeDecoder, fakeEngine } from './testFixture';

const engine = () => Object.assign(fakeEngine(), { context: fakeDecoder });

describe('project session', () => {
  beforeEach(() => {
    banners.error = banners.notice = banners.load = null;
    banners.ask = null;
  });

  it('Save As into a folder that holds a project asks inline first (fix 2)', async () => {
    const { p } = await buildFixture();
    const dir = new FakeDir('Library');
    dir.put('project.json', '{"schemaVersion":1}');
    const s = createProjectSession(p, engine(), { pick: async () => asDir(dir) });
    await s.saveAs();
    expect(dir.log).toEqual([]); // nothing written yet
    expect(p.folder).toBeNull();
    expect(banners.ask?.text).toMatch(/Replace the project in "Library"/);
    // What really happens: the samples the old project.json lists are swept (M2).
    expect(banners.ask?.text).toMatch(/Its project\.json and the samples it lists will be replaced/);
    await banners.ask!.run();
    expect(banners.ask).toBeNull();
    expect(dir.log).toContain('move project.json.tmp -> project.json');
    expect(p.folder).toBe(dir);
    expect(p.name).toBe('Library');
  });

  it('Save As into an empty folder, or the current one, saves at once', async () => {
    const { p } = await buildFixture();
    const empty = new FakeDir('New Song');
    const s = createProjectSession(p, engine(), { pick: async () => asDir(empty) });
    await s.saveAs();
    expect(banners.ask).toBeNull();
    expect(empty.log).toContain('move project.json.tmp -> project.json');
    await s.saveAs(); // same folder again: it is ours
    expect(banners.ask).toBeNull();
  });

  it('a non-empty samples/ also counts as in use; Cancel writes nothing', async () => {
    const { p } = await buildFixture();
    const dir = new FakeDir('Kits');
    (await dir.getDirectoryHandle('samples', { create: true })).put('kick.wav', [1]);
    const s = createProjectSession(p, engine(), { pick: async () => asDir(dir) });
    await s.saveAs();
    expect(banners.ask).not.toBeNull();
    banners.ask = null; // Cancel
    expect(dir.log).toEqual([]);
  });

  it('load warnings get their own banner; beforeLoad / afterLoad run (fixes 8, 10)', async () => {
    const { p: src } = await buildFixture();
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
    const { p: src } = await buildFixture();
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

  it('restore loads as an unsaved project without a folder; Save calls onSaved (autosave)', async () => {
    const { p: src } = await buildFixture();
    src.name = 'Late Night';
    const p = new Project();
    p.folder = asDir(new FakeDir('Old'));
    const calls: string[] = [];
    const dir = new FakeDir('Here');
    const s = createProjectSession(p, engine(), {
      beforeLoad: () => calls.push('before'), afterLoad: () => calls.push('after'), onSaved: () => void calls.push('saved'),
      pick: async () => asDir(dir),
    });
    const warnings = await s.restore(async () => ({ json: serialize(src), files: new Map(projectFiles(src, serialize(src))) }));
    expect(warnings).toEqual([]);
    expect(calls).toEqual(['before', 'after']);
    expect(p.name).toBe('Late Night');
    expect(p.folder).toBeNull();
    expect(p.dirty).toBe(true);
    expect(projectFingerprint(p)).toBe(projectFingerprint(src));
    // The idle dirty check must not clear it: nothing was saved yet.
    expect(p.savedFingerprint).not.toBe(projectFingerprint(p));
    await s.saveAs();
    expect(calls).toEqual(['before', 'after', 'saved']);
    expect(p.dirty).toBe(false);
  });

  it('an edit during a slow save stays unsaved; onSaved gets the version and time from before serialize (fix 3)', async () => {
    const { p } = await buildFixture();
    markEdited(p);
    const dir = new FakeDir('Song');
    const got: { version: number; t: number }[] = [];
    const s = createProjectSession(p, engine(), { onSaved: (info) => got.push(info) });
    const v0 = p.version;
    const t0 = Date.now();
    const saving = s.saveTo(asDir(dir)); // serialized synchronously, written later
    const savedPrint = projectFingerprint(p);
    p.tempo = 97; // an edit while the files are still being written
    markEdited(p);
    await saving;
    expect(got).toHaveLength(1);
    expect(got[0].version).toBe(v0);
    expect(got[0].t).toBeGreaterThanOrEqual(t0);
    expect(got[0].t).toBeLessThanOrEqual(Date.now());
    expect(p.savedFingerprint).toBe(savedPrint); // what was written, not the edited state
    expect(p.dirty).toBe(true);
    expect(projectFingerprint(p)).not.toBe(p.savedFingerprint);
  });

  it('restore is one operation: Open / New wait while the autosave is read, and the read shows Loading (M1)', async () => {
    const { p: src } = await buildFixture();
    const p = new Project();
    let picks = 0;
    const s = createProjectSession(p, engine(), { pick: async () => (picks++, null) });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const restoring = s.restore(async () => {
      await gate; // big samples still being read
      return { json: serialize(src), files: new Map(projectFiles(src, serialize(src))) };
    });
    await Promise.resolve();
    expect(p.loading).toBe(true); // the overlay blocks the editors during the read
    await s.open();
    await s.newProject();
    expect(picks).toBe(0); // ignored: a restore is running
    expect(await s.restore(async () => ({ json: serialize(src), files: new Map() }))).toBeNull(); // busy: nothing done
    release();
    expect(await restoring).toEqual([]);
    expect(p.loading).toBe(false);
    expect(p.name).toBe('Fixture');
  });

  it('a failed autosave read leaves the session as it was (M1)', async () => {
    const p = new Project();
    p.name = 'Mine';
    const s = createProjectSession(p, engine());
    await expect(s.restore(async () => { throw new Error('the autosave is gone'); })).rejects.toThrow(/gone/);
    expect(p.loading).toBe(false);
    expect(p.name).toBe('Mine');
  });
  it('exclusive (audio restart) never runs while an Open is still reading its folder', async () => {
    const { p } = await buildFixture();
    let release!: (d: FileSystemDirectoryHandle | null) => void;
    const s = createProjectSession(p, engine(), { pick: () => new Promise((r) => (release = r)) });
    const opening = s.open(); // waiting in the picker: the guard is held
    let ran = false;
    expect(await s.exclusive(async () => (ran = true))).toBeUndefined();
    expect(ran).toBe(false);
    release(null); // picker cancelled
    await opening;
    expect(await s.exclusive(async () => 'restarted')).toBe('restarted');
    // ...and holds the guard itself: an Open meanwhile is a no-op.
    let pickerOpened = false;
    const s2 = createProjectSession(p, engine(), { pick: async () => ((pickerOpened = true), null) });
    await s2.exclusive(async () => {
      await s2.open();
    });
    expect(pickerOpened).toBe(false);
  });
  it('New starts from the default kit track: kit rows, not dirty, history cleared, onFresh starts the kit load (plan 8 Task 4)', async () => {
    const { p } = await buildFixture();
    let cleared = 0;
    p.history = { clear: () => cleared++, settle: () => {}, transact: (_l: string, fn: () => unknown) => fn() } as unknown as Project['history'];
    const fresh: string[] = [];
    const s = createProjectSession(p, engine(), { onFresh: (trackId) => fresh.push(trackId) });
    await s.newProject();
    expect(banners.error).toBeNull();
    expect(p.tracks).toHaveLength(1);
    const t = p.tracks[0];
    expect(t.kind === 'drum' && t.rows.map((r) => r.name)).toEqual(['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc']);
    expect(fresh).toEqual([t.id]);
    expect(cleared).toBeGreaterThan(0);
    expect(p.dirty).toBe(false);
    expect(p.savedFingerprint).toBe(projectFingerprint(p));
  });
  it('New is not an edit: its default track bumps no version, so the untouched session is never autosaved (final I1)', async () => {
    const { p } = await buildFixture();
    markEdited(p); // the old session had edits
    const e = engine();
    const send = e.send.bind(e);
    e.send = (op: number, a?: number, b?: number, c?: number, d?: number) => {
      commandEdits(p, op); // App: e.onCommand
      return send(op, a, b, c, d);
    };
    const s = createProjectSession(p, e);
    const v0 = p.version;
    await s.newProject();
    expect(p.tracks).toHaveLength(1);
    expect(p.version).toBe(v0);
    expect(p.dirty).toBe(false);
    expect(p.baselining).toBe(false);
  });
});
