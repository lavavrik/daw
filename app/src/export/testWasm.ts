// Test helper (not a test file): the built engine.wasm for the export tests.
// `npm test` builds it first (npm run build:engine); a plain `vitest run`
// on a fresh checkout fails here with that hint instead of a bare ENOENT.
import { existsSync, readFileSync } from 'node:fs';

const WASM = new URL('../../public/engine.wasm', import.meta.url);

export function engineWasmBytes(): ArrayBuffer {
  if (!existsSync(WASM)) {
    throw new Error(`${WASM.pathname} is missing: run \`npm run build:engine\` (npm test does it first)`);
  }
  const b = readFileSync(WASM);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
