import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Cross-origin isolation is required for SharedArrayBuffer (UI <-> audio ring).
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Absolute, so the config works from any cwd: app/vitest.config.ts reuses
  // it when vitest runs from app/ (a relative 'app' would become app/app).
  root: fileURLToPath(new URL('./app', import.meta.url)),
  plugins: [svelte()],
  // root is app/, so allow the repo root for ../engine/catalog.json.
  server: { port: 5174, strictPort: true, headers, fs: { allow: ['..'] } },
  preview: { port: 5174, strictPort: true, headers },
  build: { outDir: '../dist', emptyOutDir: true },
  test: { include: ['src/**/*.test.ts'] },
});
