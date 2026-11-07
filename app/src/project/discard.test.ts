import { describe, expect, it } from 'vitest';
import { discardWarning } from './discard';

describe('discardWarning (New / Open / ⌘O guard, I1)', () => {
  it('nothing to lose: go ahead at once', () => {
    expect(discardWarning({ dirty: false, name: 'Song' }, null)).toBeNull();
  });

  it('unsaved changes ask first', () => {
    expect(discardWarning({ dirty: true, name: 'Song' }, null)).toBe('Unsaved changes in "Song" will be lost.');
  });

  it('an open "Restore last session" offer asks too, even when nothing was edited', () => {
    expect(discardWarning({ dirty: false, name: 'Untitled' }, { name: 'Late Night' })).toBe(
      'Discard the unrestored session "Late Night"? Its autosave will be overwritten.',
    );
    // Both: the offer is the bigger loss, and the edits go too.
    expect(discardWarning({ dirty: true, name: 'Untitled' }, { name: 'Late Night' })).toMatch(/^Discard the unrestored session "Late Night"\?.*Unsaved changes in "Untitled" will be lost too\.$/);
  });
});
