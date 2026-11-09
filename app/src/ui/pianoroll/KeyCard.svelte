<script lang="ts">
  // The key picker's popover content (plan 26 Task 1; docs/architecture/
  // theory.md): a root select (12 pitch classes, named in the Note names
  // style) and a scale select. Each pick is setKey at once: one "Key" undo
  // entry, the project marked edited. The card stays open (a root and a
  // scale are often picked together); Esc or a press outside closes it.
  import { SCALES, SCALE_IDS } from '../../music/scales';
  import type { MusicKey, ScaleId } from '../../music/scales';
  import { pitchClassName } from '../noteName';
  import { selectKey } from '../selectKey';

  let { value, onpick }: {
    value: MusicKey;
    onpick: (key: MusicKey) => void;
  } = $props();
</script>

<p class="lbl">Key</p>
<div class="row">
  <label>Root
    <select data-testid="pr-key-root" value={value.root} onkeydown={selectKey}
      onchange={(e) => onpick({ root: Number(e.currentTarget.value), scale: value.scale })}>
      {#each Array.from({ length: 12 }, (_, i) => i) as pc (pc)}<option value={pc}>{pitchClassName(pc)}</option>{/each}
    </select>
  </label>
  <label>Scale
    <select data-testid="pr-key-scale" value={value.scale} onkeydown={selectKey}
      onchange={(e) => onpick({ root: value.root, scale: e.currentTarget.value as ScaleId })}>
      {#each SCALE_IDS as id (id)}<option value={id}>{SCALES[id].name}</option>{/each}
    </select>
  </label>
</div>
<p class="hint">Out-of-key rows are dimmed and root rows tinted (not in Chromatic). Snap to key and Fit to key follow it.</p>

<style>
  /* Tokens only (theme.css .lbl and the select skin). */
  .lbl { margin: 0; }
  .row { display: flex; gap: 10px; }
  .row label { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--fs-ctl); }
  .hint { margin: 0; max-width: 240px; color: var(--text-2); font-size: var(--fs-lbl); }
</style>
