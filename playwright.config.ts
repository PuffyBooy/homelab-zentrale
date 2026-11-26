import { defineConfig, devices } from '@playwright/test';

/** Fixed setup token for e2e only (HZ_SETUP_TOKEN is accepted only with NODE_ENV=test). */
export const E2E_SETUP_TOKEN = 'e2e-setup-token-0123456789abcdef';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    trace: 'off',
  },
  webServer: [
    // Core serves the built web app (run `pnpm build` first).
    {
      command: 'rm -rf test-results/data && node apps/core/dist/index.js',
      url: 'http://127.0.0.1:8099/api/health',
      reuseExistingServer: !process.env.CI,
      env: {
        HZ_SECRET_KEY: Buffer.alloc(32, 0).toString('base64'),
        HZ_PORT: '8099',
        HZ_DATA_DIR: 'test-results/data',
        HZ_SETUP_TOKEN: E2E_SETUP_TOKEN,
        NODE_ENV: 'test',
      },
    },
    // Vite dev server for the dev-only UI gallery (/dev/ui).
    {
      command: 'pnpm --filter @hz/web exec vite --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174/dev/ui',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
