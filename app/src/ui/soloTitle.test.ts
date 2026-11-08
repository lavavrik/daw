import { describe, expect, it } from 'vitest';
import { soloAddClick, soloTitle } from './soloTitle';

describe('solo titles', () => {
  it('macOS names ⌘ / Shift (Ctrl-click is the context menu there); elsewhere Ctrl / Shift', () => {
    expect(soloAddClick(true)).toBe('⌘/Shift-click');
    expect(soloAddClick(false)).toBe('Ctrl/Shift-click');
  });
  it('the title, soloed or not', () => {
    expect(soloTitle('Drums', false, '', true)).toBe('Solo Drums: play only this track (⌘/Shift-click: add it to the soloed ones)');
    expect(soloTitle('Bass', false, '; returns keep playing', false)).toBe('Solo Bass: play only this track; returns keep playing (Ctrl/Shift-click: add it to the soloed ones)');
    expect(soloTitle('Drums', true)).toBe('Drums is soloed — click to unsolo');
  });
});
