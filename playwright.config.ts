import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build (`npm run preview`: engine -> WASM,
// vite build, vite preview on the fixed port with COOP/COEP headers).
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:5174' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Let the AudioContext run headless without waiting on a real gesture.
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
  webServer: {
    command: 'npm run preview',
    port: 5174,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
