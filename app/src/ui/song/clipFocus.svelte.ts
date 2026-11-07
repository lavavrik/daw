// The audio clip the Clip tab edits (plan 9): the timeline sets it when an
// audio clip is clicked, selected alone, placed by a drop or split; the
// bottom panel's Clip tab (ClipPanel.svelte) shows it while its track is the
// selected one. UI state only: never saved, never part of undo (a stale id
// just matches no clip, and the panel then asks for one).
import { baseName } from '../../audio/samples';
import type { Project } from '../../state/project.svelte';

export const clipFocus = $state<{ id: string | null }>({ id: null });

/** An audio clip's name: its sample's file name without extension ("missing sample" when gone). */
export function sampleName(p: Project, sampleId: number | null): string {
  if (sampleId === null) return 'missing sample';
  const f = p.sampleFiles.get(sampleId);
  return f ? baseName(f.name) : '?';
}
