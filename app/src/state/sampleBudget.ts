// Sample memory budget (spec addendum §3.3). The engine's sample arena is a
// bump allocator capped at MAX_ARENA_FLOATS (1 GiB): every upload since the
// last load (RESET_ALL) or audio restart (a new engine) keeps its space,
// replaced samples included, until the project is reopened. The UI mirrors
// that count in Project.arenaFloats so an import can refuse a file that
// would not fit BEFORE uploading it (nothing half-loaded, no clip placed);
// the engine's own ERR_OUT_OF_MEMORY stays the backstop.
//
// Who counts: importSample reserves a file's floats when it takes the id
// (and gives them back if the engine refuses); a project load sets the
// count from what it uploaded; the audio restart sets it from the samples
// it re-uploaded, and its late uploads (Replayed.rest) add theirs.
import { MAX_ARENA_FLOATS } from '../audio/protocol';
import type { Project } from './project.svelte';

const MB_FLOATS = (1024 * 1024) / 4;

/** Floats one decoded sample takes in the arena (frames × channels). */
export const sampleFloats = (channels: Float32Array[]) => channels.reduce((n, ch) => n + ch.length, 0);

/** Would `floats` more still fit in the engine's sample memory? */
export const fitsBudget = (p: Project, floats: number) => p.arenaFloats + floats <= MAX_ARENA_FLOATS;

const limitText = () => {
  const mb = MAX_ARENA_FLOATS / MB_FLOATS;
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
};

/** The Browser footer's "412 MB / 1 GB": sample memory used / the limit. */
export function budgetText(p: Project): string {
  return `${Math.round(p.arenaFloats / MB_FLOATS)} MB / ${limitText()}`;
}

/**
 * The refusal banner (addendum §3.3): the file, the size it needs, what is
 * free and how to free more. The need rounds up and the free space down,
 * so the two never read as if it fit.
 */
export function overBudgetText(p: Project, name: string, floats: number): string {
  const need = Math.ceil(floats / MB_FLOATS);
  const free = Math.max(0, Math.floor((MAX_ARENA_FLOATS - p.arenaFloats) / MB_FLOATS));
  return `${name} needs ${need} MB of sample memory; ${free} MB is free (${limitText()} limit). Removed samples are freed when the project is reopened.`;
}
