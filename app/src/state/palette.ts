// The track palette (spec §2). It lives in state/ because new tracks take
// their colour from it (state must not import ui/); ui/theme.ts re-exports it
// for components and canvas code, and theme.css mirrors it as --track-0..7
// (theme.test.ts keeps the three in sync).

/**
 * 8 vivid colours that read on the slate surfaces. A new track takes
 * TRACK_COLORS[slot % 8]; saved projects keep whatever colour they were saved
 * with, so changing this list never recolours an existing project.
 */
export const TRACK_COLORS: readonly string[] = [
  '#ff7a6b', '#ffc145', '#a6e06a', '#4fd6c4',
  '#5cc8ff', '#9b8cff', '#f47cc3', '#e0d45a',
];
