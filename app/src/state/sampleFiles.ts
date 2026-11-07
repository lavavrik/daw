// The original bytes of a loaded sample (Project.sampleFiles), with a short
// content hash. The hash goes into the saved file name
// ("samples/<id>-<hash>-<name>", project/serialize.ts), so a save never
// overwrites an existing sample file with different bytes: files are only
// ever added before project.json is replaced (project/fsFolder.ts).
import type { SampleFile } from './project.svelte';

/** FNV-1a 32-bit of the bytes as 8 hex digits (not cryptographic; a name tag). */
export function contentHash(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A SampleFile with its hash computed once (drop / load), not on every serialize. */
export function sampleFile(name: string, type: string, bytes: ArrayBuffer): SampleFile {
  return { name, type, bytes, hash: contentHash(bytes) };
}
