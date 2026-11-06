import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:5174' },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
