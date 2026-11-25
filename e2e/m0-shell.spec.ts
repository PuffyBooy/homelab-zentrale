import { expect, test } from '@playwright/test';

test('core answers /api/health', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('web app shows the empty page with NavRail and design tokens', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(9);
  await expect(nav.getByRole('link', { name: /Übersicht/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Übersicht');

  // components.css is loaded (NavRail width) and tokens resolve (accent-soft on the active item).
  await expect(nav).toHaveCSS('width', '210px');
  await expect(nav.locator('.hz-nav-active')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('deep links fall back to the SPA and mark the nav item', async ({ page }) => {
  await page.goto('/servers');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Server');
  await expect(
    page
      .getByRole('navigation')
      .getByRole('link', { name: /Server/ })
      .first(),
  ).toHaveAttribute('aria-current', 'page');
});
