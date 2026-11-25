import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    trace: 'off',
  },
  // Core serves the built web app (run `pnpm build` first).
  webServer: {
    command: 'node apps/core/dist/index.js',
    url: 'http://127.0.0.1:8099/api/health',
    reuseExistingServer: !process.env.CI,
    env: {
      HZ_SECRET_KEY: Buffer.alloc(32, 0).toString('base64'),
      HZ_PORT: '8099',
      HZ_DATA_DIR: 'test-results/data',
      NODE_ENV: 'test',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
