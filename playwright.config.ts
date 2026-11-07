import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build (`npm run preview`: engine -> WASM,
// vite build, vite preview on the fixed port with COOP/COEP headers).
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:5174' },
  projects: [
    {
      // Everything except the timing-sensitive tests: runs in parallel workers.
      name: 'chromium',
      testIgnore: '**/serial.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // Let the AudioContext run headless without waiting on a real gesture.
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
    {
      // Real-time assertions (engine block rate, CPU load, dropouts) are only
      // meaningful when nothing else competes for the CPU. This project
      // depends on `chromium`, so it starts only after every parallel test has
      // finished, and its single file (serial.spec.ts) runs in one worker,
      // test after test.
      name: 'serial',
      testMatch: '**/serial.spec.ts',
      dependencies: ['chromium'],
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
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
