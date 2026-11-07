// The original bytes of a loaded sample (Project.sampleFiles), with a short
// content hash. The hash goes into the saved file name
// ("samples/<id>-<hash>-<name>", project/serialize.ts), so a save never
// overwrites an existing sample file with different bytes: files are only
// ever added before project.json is replaced (project/fsFolder.ts).
//
// The hash is the first 8 hex digits of SHA-256 by crypto.subtle (async, off
// the UI thread: a synchronous loop over a 100 MB+ sample would stall the
// UI on every drop and load). Projects saved before used FNV-1a names of the
// same width; those still load, because a load reads the path project.json
// lists and never checks the hash. The next save writes the new name.
import type { SampleFile } from './project.svelte';

/** SHA-256 of the bytes, first 8 hex digits (a name tag, not a security check). */
export async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes), 0, 4);
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A SampleFile with its hash computed once (drop / load), not on every serialize. */
export async function sampleFile(name: string, type: string, bytes: ArrayBuffer): Promise<SampleFile> {
  return { name, type, bytes, hash: await contentHash(bytes) };
}
