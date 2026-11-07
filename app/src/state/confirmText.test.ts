import { describe, expect, it } from 'vitest';
import { Project, currentPattern } from './project.svelte';
import { addDrumTrack } from './actions';
import { addSynthTrack } from './rack-actions';
import { newPattern } from './pattern-actions';
import { addClip } from './song-actions';
import { clearPatternText, removeTrackText } from './confirmText';

function setup() {
  const sink = { send() { return true; } };
  const p = new Project();
  const d = addDrumTrack(p, sink)!;
  const s = addSynthTrack(p, sink)!;
  return { p, sink, d, s };
}

describe('confirm texts', () => {
  it('clear names the pattern and the clips that use it', () => {
    const { p, sink, s } = setup();
    const name = currentPattern(s).name;
    expect(clearPatternText(s, 3)).toBe(`Clear all 3 notes from pattern "${name}" of "${s.name}"? This cannot be undone.`);
    addClip(p, sink, s.id, { start: 0 });
    expect(clearPatternText(s, 1)).toBe(
      `Clear all 1 note from pattern "${name}" of "${s.name}"? The clip that uses it is affected too. This cannot be undone.`,
    );
    addClip(p, sink, s.id, { start: 3840 });
    expect(clearPatternText(s, 2)).toContain('Both clips that use it are affected too.');
    addClip(p, sink, s.id, { start: 7680 });
    expect(clearPatternText(s, 2)).toContain('All 3 clips that use it are affected too.');
    newPattern(p, sink, s.id); // a clip of another pattern does not count
    expect(clearPatternText(s, 2)).not.toContain('clip');
  });

  it('remove track says its clips and patterns go too', () => {
    const { p, sink, d } = setup();
    expect(removeTrackText(d)).toBe(`Remove track "${d.name}" and its 1 pattern? This cannot be undone.`);
    newPattern(p, sink, d.id);
    addClip(p, sink, d.id, { start: 0 });
    expect(removeTrackText(d)).toBe(`Remove track "${d.name}" with its 2 patterns and 1 clip? This cannot be undone.`);
    addClip(p, sink, d.id, { start: 3840 });
    expect(removeTrackText(d)).toContain('its 2 patterns and 2 clips?');
  });
});
