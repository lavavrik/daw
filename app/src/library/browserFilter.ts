// Pure filtering for the Browser pane's tabs and search (plan 20 Task 6).
// UI state only: nothing here is saved.
//
//   tab     which sections show: All = everything, Samples = the folder tree
//           and the built-in kits' samples, Patches = patches/*.json, Kits =
//           the built-in kits (state/kits.ts KITS; the library has no
//           kit-folder concept).
//   search  case-insensitive substring of the name. A folder stays shown when
//           it, or anything in its *loaded* listing, matches. Folders never
//           expanded are not listed (scan.ts is lazy) and so cannot match
//           (the pane says so: hasUnscannedFolder). A folder whose own name
//           matches shows all its contents. While a query is active, folding
//           a folder only hides its children (`collapsed` set, see
//           isFolderOpen): its listing stays loaded, so it stays visible.
//           Clearing the search drops that set and restores the real state.
import type { LibListing } from './scan';

export type BrowserTab = 'all' | 'samples' | 'patches' | 'kits';

export const BROWSER_TABS: { id: BrowserTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'samples', label: 'Samples' },
  { id: 'patches', label: 'Patches' },
  { id: 'kits', label: 'Kits' },
];

export interface TabSections { samples: boolean; patches: boolean; kit: boolean }

export function tabSections(tab: BrowserTab): TabSections {
  return {
    samples: tab === 'all' || tab === 'samples',
    patches: tab === 'all' || tab === 'patches',
    kit: tab === 'all' || tab === 'samples' || tab === 'kits',
  };
}

/** Case-insensitive substring match; an empty (or blank) query matches everything. */
export function nameMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

/** True when `path` (a loaded folder) holds a sample or sub-folder that matches, at any loaded depth. */
export function hasMatchInside(listings: Record<string, LibListing>, path: string, query: string): boolean {
  const l = listings[path];
  if (!l) return false;
  return l.samples.some((s) => nameMatches(s.name, query)) ||
    l.folders.some((f) => nameMatches(f.name, query) || hasMatchInside(listings, f.path, query));
}

/** Folder visibility under a query: its own name matches, or something loaded inside it does. */
export function folderVisible(listings: Record<string, LibListing>, path: string, name: string, query: string): boolean {
  return nameMatches(name, query) || hasMatchInside(listings, path, query);
}

/**
 * Is a folder's content shown? Without a query: the library's own expand state
 * (it has a listing). Under a query: it must also not be in `collapsed`, the
 * search-time folds, which never touch the library's listings.
 */
export function isFolderOpen(listings: Record<string, LibListing>, collapsed: ReadonlySet<string>, path: string, query: string): boolean {
  return path in listings && !(query.trim() && collapsed.has(path));
}

/** True when some folder listed so far was never opened, so its files can't be searched. */
export function hasUnscannedFolder(listings: Record<string, LibListing>): boolean {
  return Object.values(listings).some((l) => l.folders.some((f) => !(f.path in listings)));
}
