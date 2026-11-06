import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Cross-origin isolation is required for SharedArrayBuffer (UI <-> audio ring).
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: 'app',
  plugins: [svelte()],
  server: { port: 5174, strictPort: true, headers },
  preview: { port: 5174, strictPort: true, headers },
  build: { outDir: '../dist', emptyOutDir: true },
  test: { include: ['src/**/*.test.ts'] },
});
