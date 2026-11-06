# House DAW

A browser DAW: a Rust audio engine compiled to WASM and hosted in an
AudioWorklet, with a Svelte 5 UI. Design:
[docs/superpowers/specs/2026-11-06-daw-design.md](docs/superpowers/specs/2026-11-06-daw-design.md).

## Prerequisites

- Rust with the WASM target: `rustup target add wasm32-unknown-unknown`
- Node 26 and npm
- Chrome (desktop, macOS); e2e uses `npx playwright install chromium`

## Commands

- `npm install`
- `npm test` — Rust unit tests (`cargo test --workspace`) + Vitest
- `npm run build:engine` — builds `app/public/engine.wasm`
- `npm run dev` — builds the engine, serves on http://localhost:5174
  (cross-origin isolated: COOP/COEP headers set)
- `npm run preview` — production build + preview on the same port
- `npm run test:e2e` — Playwright
