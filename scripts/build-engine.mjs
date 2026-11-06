// Builds the Rust engine to WASM and copies it where the app serves it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(
  'cargo',
  ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'daw-engine'],
  { cwd: root, stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const out = resolve(root, 'app/public/engine.wasm');
mkdirSync(dirname(out), { recursive: true });
copyFileSync(resolve(root, 'target/wasm32-unknown-unknown/release/daw_engine.wasm'), out);
console.log(`engine.wasm -> ${out}`);
