// Running vitest from app/ (an editor's test runner, or `cd app && npx
// vitest`) would otherwise find no config: no Svelte plugin, so every
// `.svelte.ts` module fails with "$state is not defined". The repo-root config
// is the single source of truth (its root is absolute, so it works from here).
export { default } from '../vite.config';
