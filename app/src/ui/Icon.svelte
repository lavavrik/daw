<script lang="ts">
  // One wrapper for every Phosphor icon (docs/architecture/ui-theme.md, "Icons").
  // Pass the per-icon component (`import Play from 'phosphor-svelte/lib/Play'`),
  // never the package barrel, so the bundle only carries what is used.
  //  - colour is currentColor: the icon takes the button's `color`;
  //  - decorative by default (aria-hidden); give `label` only for a
  //    standalone icon with no text or labelled button around it.
  import type { Component } from 'svelte';
  // The package's props type is not reachable through its exports map, so the
  // few props used here are typed locally.
  type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

  let { icon: Glyph, size = 16, weight = 'regular', label }: {
    icon: Component<any>;
    /** Pixels (square). */
    size?: number;
    weight?: IconWeight;
    /** Accessible name; unset = decorative (aria-hidden). */
    label?: string;
  } = $props();
</script>

{#if label}
  <Glyph {size} {weight} color="currentColor" role="img" aria-label={label} />
{:else}
  <Glyph {size} {weight} color="currentColor" role="presentation" aria-hidden="true" />
{/if}
