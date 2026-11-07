import { describe, expect, it } from 'vitest';
import { discardWarning, warnOnUnload } from './discard';

describe('discardWarning (New / Open / ⌘O guard, I1)', () => {
  it('nothing to lose: go ahead at once', () => {
    expect(discardWarning({ dirty: false, name: 'Song' }, null)).toBeNull();
  });

  it('unsaved changes ask first', () => {
    expect(discardWarning({ dirty: true, name: 'Song' }, null)).toBe('Unsaved changes in "Song" will be lost.');
  });

  it('an open "Restore last session" offer asks too, even when nothing was edited', () => {
    expect(discardWarning({ dirty: false, name: 'Untitled' }, { name: 'Late Night' })).toBe(
      'Discard the unrestored session "Late Night"? Its autosave will be deleted.',
    );
    // Both: the offer is the bigger loss, and the edits go too.
    expect(discardWarning({ dirty: true, name: 'Untitled' }, { name: 'Late Night' })).toMatch(/^Discard the unrestored session "Late Night"\?.*Unsaved changes in "Untitled" will be lost too\.$/);
  });
});

describe('warnOnUnload (beforeunload, P9)', () => {
  it('only a dirty project with a folder asks before the tab closes', () => {
    const folder = {} as FileSystemDirectoryHandle;
    expect(warnOnUnload({ dirty: true, folder })).toBe(true);
    expect(warnOnUnload({ dirty: false, folder })).toBe(false);
    // No folder (never saved, or restored): the autosave is its only copy and
    // a restored session stays "unsaved" forever — no prompt on every close.
    expect(warnOnUnload({ dirty: true, folder: null })).toBe(false);
  });
});
