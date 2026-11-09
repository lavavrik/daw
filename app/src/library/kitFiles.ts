// The built-in kits' files (state/kits.ts KITS), bundled like the starter kit
// (library/starter.ts): Vite resolves samples/kits/<id>/<file> to URLs (dev:
// /@fs/; a build: hashed assets) and they are read with fetch(). Read-only.
// The starter kit (KITS[0]) keeps its own files in samples/starter/.
//
// A generated kit's File is named "<kit id>-<file>" ("garage-kick.wav"): a
// saved project's sample file and a row filled by dragging it then say which
// kit it came from (every generated kit has a "kick.wav"). Starter files keep
// their own names (the default kit's saved files are unchanged).
import { audioMime } from './scan';
import { STARTER_KIT, fetchBytes, starterSample } from './starter';
import { STARTER_KIT_ID } from '../state/kits';

const urls = import.meta.glob('../../../samples/kits/*/*.wav', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** "<kit id>/<file>" -> URL, for the generated kits. */
export const KIT_FILE_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(urls).map(([k, url]) => [k.split('/').slice(-2).join('/'), url]),
);

/** The URL of a kit's file, or null if it is not bundled. */
export function kitFileUrl(kitId: string, file: string, table = KIT_FILE_URLS): string | null {
  if (kitId === STARTER_KIT_ID) return STARTER_KIT.files.find((f) => f.path === file)?.url ?? null;
  return table[`${kitId}/${file}`] ?? null;
}

/** The File name a kit's file gets in the project (see the header). */
export const kitFileName = (kitId: string, file: string) => (kitId === STARTER_KIT_ID ? file : `${kitId}-${file}`);

/** A kit file's bytes as a File (to preview, import or drop). Rejects for a file not in the kit or a failed fetch. */
export async function kitSample(kitId: string, file: string, table = KIT_FILE_URLS, fetch = fetchBytes): Promise<File> {
  if (kitId === STARTER_KIT_ID) return starterSample(file, STARTER_KIT, fetch);
  const url = kitFileUrl(kitId, file, table);
  if (!url) throw new Error(`"${file}" is not in the "${kitId}" kit`);
  const name = kitFileName(kitId, file);
  return new File([await fetch(url)], name, { type: audioMime(name) });
}
