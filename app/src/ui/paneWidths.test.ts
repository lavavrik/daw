import { describe, expect, it } from 'vitest';
import { PANES, clampPaneWidth } from './paneWidths.svelte';

describe('pane widths', () => {
  it('clamps to min..max and rounds', () => {
    expect(clampPaneWidth('library', 10)).toBe(PANES.library.min);
    expect(clampPaneWidth('library', 9999)).toBe(PANES.library.max);
    expect(clampPaneWidth('trackHeaders', 200.6)).toBe(201);
  });
  it('falls back to the default on garbage (a bad stored value)', () => {
    expect(clampPaneWidth('trackHeaders', Number('abc'))).toBe(PANES.trackHeaders.def);
  });
  it('defaults are the old fixed widths', () => {
    expect(PANES.library.def).toBe(220);
    expect(PANES.trackHeaders.def).toBe(176);
  });
});
