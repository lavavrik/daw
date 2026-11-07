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
import { projectFiles, projectFingerprint, serialize } from './serialize';

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
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** At most `n` warnings in a banner line, then "+N more" (all go to the console). */
export function warningsText(title: string, warnings: string[], n = 6): string {
  const shown = warnings.slice(0, n).join(' · ');
  return `${title}: ${shown}${warnings.length > n ? ` · +${warnings.length - n} more (see console)` : ''}`;
}

/** "Unsaved changes" are measured from now. */
export function markSaved(p: Project) {
  p.savedFingerprint = projectFingerprint(p);
  p.dirty = false;
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
  /** The folder picker (tests pass a fake). */
  pick?: () => Promise<FileSystemDirectoryHandle | null>;
}

export function createProjectSession(p: Project, engine: SessionEngine, opts: SessionOptions = {}): ProjectSession {
  const pick = opts.pick ?? pickProjectFolder;
  let busy = false;
  const once = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };

  async function saveTo(dir: FileSystemDirectoryHandle) {
    const json = serialize(p);
    await writeProject(dir, json, projectFiles(p, json));
    p.folder = dir;
    markSaved(p);
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

  async function openFrom(dir: FileSystemDirectoryHandle): Promise<string[]> {
    const { json, files } = await readProject(dir); // nothing changes if this fails
    const warnings = await replace(json, files);
    p.folder = dir;
    markSaved(p);
    banners.load = null;
    if (warnings.length) {
      console.warn(`Opened "${p.name}" with changes:\n${warnings.join('\n')}`);
      banners.load = warningsText(`Opened "${p.name}" — skipped or changed`, warnings);
    }
    return warnings;
  }

  async function saveInto(dir: FileSystemDirectoryHandle, name: string) {
    const old = p.name;
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
          text: `Replace the project in "${target.name}"? Its project.json is overwritten (other files are kept).`,
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
