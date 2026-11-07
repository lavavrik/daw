// Project ▸ New / Open… / Save / Save As… as the user sees them: one
// operation at a time, results and problems as banners (never confirm() /
// alert(); Save As over an existing project asks via banners.ask), and the
// "unsaved" baseline reset after each success.
//
// saveTo / openFrom take any FileSystemDirectoryHandle (a picked folder, or
// OPFS in the e2e tests via __daw.saveTo / __daw.openFrom) and throw on
// failure; the menu commands wrap them with the picker and the banners.
import { addDrumTrack } from '../state/actions';
import { banners, flashHint } from '../state/banners.svelte';
import { Project } from '../state/project.svelte';
import { folderInUse, pickProjectFolder, readProject, writeProject } from './fsFolder';
import { loadProject } from './load';
import type { LoadEngine, SampleDecoder } from './load';
import { fingerprintOf, projectFiles, projectFingerprint, serialize } from './serialize';

export interface SessionEngine extends LoadEngine {
  readonly context: SampleDecoder;
}

export interface ProjectSession {
  newProject(): Promise<void>;
  open(): Promise<void>;
  save(): Promise<void>;
  saveAs(): Promise<void>;
  saveTo(dir: FileSystemDirectoryHandle): Promise<void>;
  /** Returns the load warnings (also shown in the notice banner). */
  openFrom(dir: FileSystemDirectoryHandle): Promise<string[]>;
  /**
   * Load an autosave (project/autosave.ts) as an unsaved project with no
   * folder: same validation and warnings banner as Open; the name is kept.
   * `read` gives the autosave (project.json + samples); it runs inside the
   * one-operation-at-a-time guard with Project.loading set (the "Loading…"
   * overlay), so no Open / New can start while big samples are read.
   * Throws on failure (the session is unchanged if `read` fails). Returns
   * the load warnings, or null if another New / Open / Save was running
   * (nothing done).
   */
  restore(read: () => Promise<{ json: unknown; files: Map<string, ArrayBuffer> }>): Promise<string[] | null>;
  /**
   * Run `fn` as one more operation under the same one-at-a-time guard (the
   * audio restart, audio/restart.ts: it must not interleave with an Open
   * still reading its folder). Undefined (fn not run) while another runs.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T | undefined>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** At most `n` warnings in a banner line, then "+N more" (all go to the console). */
export function warningsText(title: string, warnings: string[], n = 6): string {
  const shown = warnings.slice(0, n).join(' · ');
  return `${title}: ${shown}${warnings.length > n ? ` · +${warnings.length - n} more (see console)` : ''}`;
}

/** savedFingerprint of a project that has no saved copy (a restored autosave). */
export const NEVER_SAVED = '';

/**
 * "Unsaved changes" are measured from now, or from `fingerprint` (the state a
 * save wrote, which edits made during the write no longer match).
 */
export function markSaved(p: Project, fingerprint = projectFingerprint(p)) {
  p.savedFingerprint = fingerprint;
  p.dirty = false;
}

/** What a finished save wrote: the edit count and time when it was serialized. */
export interface SavedInfo {
  version: number;
  t: number;
}

export interface SessionOptions {
  /**
   * Runs once a New / Open is known to go ahead, right before the engine is
   * stopped and reset (loadProject): the App stops the transport through its
   * own path (recorder stop tick) and releases held keys.
   */
  beforeLoad?: () => void;
  /** Runs after every New / Open that got that far, success or not (recorder resync). */
  afterLoad?: () => void;
  /**
   * After every successful save, with the version / time of its snapshot
   * (App: records the explicit-save time; drops a pending autosave only if
   * no edit landed during the write).
   */
  onSaved?: (info: SavedInfo) => void;
  /** The folder picker (tests pass a fake). */
  pick?: () => Promise<FileSystemDirectoryHandle | null>;
}

export function createProjectSession(p: Project, engine: SessionEngine, opts: SessionOptions = {}): ProjectSession {
  const pick = opts.pick ?? pickProjectFolder;
  let busy = false;
  /** One New / Open / Save / restore at a time: undefined (nothing run) while another runs. */
  const once = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  async function saveTo(dir: FileSystemDirectoryHandle) {
    // The snapshot: edits may land while the files are written (async).
    const info: SavedInfo = { version: p.version, t: Date.now() };
    const json = serialize(p);
    await writeProject(dir, json, projectFiles(p, json));
    p.folder = dir;
    markSaved(p, fingerprintOf(json));
    if (p.version !== info.version) p.dirty = true; // those edits are not in the folder
    opts.onSaved?.(info);
  }

  /** loadProject with the hooks; afterLoad runs whenever beforeLoad did. */
  async function replace(json: unknown, files: Map<string, ArrayBuffer>): Promise<string[]> {
    let started = false;
    try {
      return await loadProject(p, engine, json, files, engine.context, {
        beforeLoad: () => {
          started = true;
          opts.beforeLoad?.();
        },
      });
    } finally {
      if (started) opts.afterLoad?.();
    }
  }

  function showWarnings(verb: string, warnings: string[]) {
    banners.load = null;
    if (warnings.length) {
      console.warn(`${verb} "${p.name}" with changes:\n${warnings.join('\n')}`);
      banners.load = warningsText(`${verb} "${p.name}" — skipped or changed`, warnings);
    }
  }

  async function openFrom(dir: FileSystemDirectoryHandle): Promise<string[]> {
    const { json, files } = await readProject(dir); // nothing changes if this fails
    const warnings = await replace(json, files);
    p.folder = dir;
    markSaved(p);
    showWarnings('Opened', warnings);
    return warnings;
  }

  async function restore(read: () => Promise<{ json: unknown; files: Map<string, ArrayBuffer> }>): Promise<string[]> {
    let saved: { json: unknown; files: Map<string, ArrayBuffer> };
    // Reading big samples takes a while: block the editors meanwhile, like
    // the load itself does (loadProject sets loading again and clears it).
    p.loading = true;
    try {
      saved = await read();
    } finally {
      p.loading = false;
    }
    const warnings = await replace(saved.json, saved.files);
    // No folder (the handle is not kept in an autosave) and never saved:
    // NEVER_SAVED matches no fingerprint, so the idle dirty check keeps the
    // "● unsaved" mark until a Save.
    p.folder = null;
    p.savedFingerprint = NEVER_SAVED;
    p.dirty = true;
    showWarnings('Restored', warnings);
    return warnings;
  }

  async function saveInto(dir: FileSystemDirectoryHandle, name: string) {
    const old = p.name;
    p.history?.settle(); // the name is saved, not an edit (history.ts settle)
    p.name = name;
    try {
      await saveTo(dir);
      banners.error = null;
      flashHint(`Saved "${p.name}"`);
    } catch (e) {
      p.name = old;
      banners.error = `Couldn't save "${name}" — ${message(e)}`;
    }
  }

  /**
   * Pick a folder; one that already holds a project or samples (and is not
   * this project's own folder) is only written after an inline "Replace?".
   */
  async function saveAs() {
    let dir: FileSystemDirectoryHandle | null;
    try {
      dir = await pick();
      if (!dir) return;
      const ours = p.folder !== null && (await dir.isSameEntry(p.folder));
      if (!ours && (await folderInUse(dir))) {
        const target = dir;
        banners.ask = {
          text: `Replace the project in "${target.name}"? Its project.json and the samples it lists will be replaced.`,
          ok: 'Replace',
          run: async () => {
            banners.ask = null;
            await once(() => saveInto(target, target.name));
          },
        };
        return;
      }
    } catch (e) {
      banners.error = `Couldn't save — ${message(e)}`;
      return;
    }
    await saveInto(dir, dir.name);
  }

  return {
    saveTo,
    openFrom,
    exclusive: (fn) => once(fn),
    restore: async (read) => (await once(() => restore(read))) ?? null,
    saveAs: () => once(saveAs),
    save: () => once(() => (p.folder ? saveInto(p.folder, p.name) : saveAs())),
    open: () =>
      once(async () => {
        let dir: FileSystemDirectoryHandle | null = null;
        try {
          dir = await pick();
          if (!dir) return;
          await openFrom(dir);
          banners.error = null;
          flashHint(`Opened "${p.name}"`);
        } catch (e) {
          banners.error = `Couldn't open "${dir?.name ?? 'project'}" — ${message(e)}`;
        }
      }),
    newProject: () =>
      once(async () => {
        try {
          await replace(serialize(new Project()), new Map());
          addDrumTrack(p, engine); // like a fresh start
          p.history?.clear(); // that track is the starting point, not an edit
          p.folder = null;
          markSaved(p);
          banners.error = null;
          banners.load = null;
        } catch (e) {
          banners.error = `Couldn't start a new project — ${message(e)}`;
        }
      }),
  };
}
