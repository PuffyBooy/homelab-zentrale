import { expect, test } from '@playwright/test';

test('core answers /api/health', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('web app loads design tokens and self-hosted fonts behind the login', async ({ page }) => {
  const foreign: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol.startsWith('http') && url.host !== '127.0.0.1:8099') foreign.push(req.url());
  });

  await page.goto('/');
  // Since M1 the overview needs a session: a fresh core asks for setup, otherwise for login.
  await expect(page).toHaveURL(/\/(setup|login)$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // tokens.css resolves (bg-000 on body) and fonts come from /fonts, not Google.
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('body')).toHaveCSS('font-family', /Space Grotesk/);
  await page.evaluate('document.fonts.ready');
  expect(foreign).toEqual([]);
});

test('deep links fall back to the SPA and keep the guard', async ({ page }) => {
  await page.goto('/servers');
  await expect(page).toHaveURL(/\/(setup|login)$/);
});

test('manifest and service worker are served', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  const json = (await manifest.json()) as { name: string; short_name: string; icons: unknown[] };
  expect(json.name).toBe('Homelab-Zentrale');
  expect(json.short_name).toBe('Zentrale');
  expect(json.icons.length).toBeGreaterThanOrEqual(3);
  expect((await request.get('/sw.js')).status()).toBe(200);
  expect((await request.get('/icons/icon-512.png')).status()).toBe(200);
});
