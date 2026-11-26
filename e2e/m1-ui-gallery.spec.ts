import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * M1 UI gallery: renders every card of /dev/ui (Vite dev server, port 5174) in all three themes,
 * saves screenshots and checks each card against the original preview HTML in
 * design/reference/previews (same DOM after dropping inline styles). No pixel baselines.
 */

const GALLERY = 'http://127.0.0.1:5174/dev/ui';
const ROOT = path.resolve(import.meta.dirname, '..');
const PREVIEWS = path.join(ROOT, 'design/reference/previews');
const SHOTS = path.join(ROOT, 'test-results/ui-gallery');
const OVERVIEW = path.join(ROOT, 'docs/screenshots/m1');

const THEMES = ['dark', 'light', 'wall'] as const;
const CARDS = [
  'Dashboard',
  'Alert',
  'Badge',
  'Button',
  'CommitRow',
  'GameServer',
  'GameTemplates',
  'Icon',
  'Metric',
  'NavRail',
  'RepoRow',
  'ServerList',
  'ServerSwitch',
  'ServiceRow',
  'ShareLink',
  'Sparkline',
  'StatusDot',
  'Terminal',
  'Tile',
  'Toggle',
  'UsageBar',
  'WebCheckRow',
];

// The previews load React from jsDelivr; serve the local copies instead (offline, same version).
const req = createRequire(path.join(ROOT, 'packages/ui/package.json'));
const pkgDir = (name: string): string => path.dirname(req.resolve(`${name}/package.json`));
const UMD: Record<string, string> = {
  'react.production.min.js': path.join(pkgDir('react'), 'umd/react.production.min.js'),
  'react-dom.production.min.js': path.join(pkgDir('react-dom'), 'umd/react-dom.production.min.js'),
};

test.use({ viewport: { width: 1320, height: 1000 } });

/** Google Fonts (imported by design/components.css) answer with an empty stylesheet: no network. */
async function offline(page: Page): Promise<void> {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/react(-dom)?@18\.3\.1\/umd\//, (route) => {
    const file = UMD[path.basename(new URL(route.request().url()).pathname)];
    return file
      ? route.fulfill({ path: file, contentType: 'text/javascript' })
      : route.abort('blockedbyclient');
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function openGallery(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.goto(`${GALLERY}?theme=${theme}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('[data-card]')).toHaveCount(CARDS.length);
  await page.locator('html').evaluate((html) => html.ownerDocument.fonts.ready);
}

async function openPreview(page: Page, name: string): Promise<void> {
  await page.goto(pathToFileURL(path.join(PREVIEWS, `${name}.html`)).href);
  await expect(page.locator('#root > *').first()).toBeAttached();
}

/** Normalised DOM of a preview root: inline styles and gallery-only wrapper markers removed. */
async function normalisedRoot(
  page: Page,
  selector: string,
): Promise<{ cls: string; html: string }> {
  return page.locator(selector).evaluate((root) => {
    const clone = root.cloneNode(true);
    for (const el of [clone, ...clone.querySelectorAll('*')]) el.removeAttribute('style');
    for (const el of clone.querySelectorAll('[data-wrap]')) {
      el.removeAttribute('class');
      el.removeAttribute('data-wrap');
    }
    return { cls: clone.getAttribute('class') ?? '', html: clone.innerHTML };
  });
}

for (const theme of THEMES) {
  test(`gallery renders every card in ${theme} without console errors`, async ({ page }) => {
    await offline(page);
    const errors = collectErrors(page);
    await openGallery(page, theme);

    mkdirSync(OVERVIEW, { recursive: true });
    await page.screenshot({
      path: path.join(OVERVIEW, `gallery-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    for (const name of CARDS) {
      const card = page.locator(`[data-card="${name}"]`);
      await expect(card.locator('[data-preview-root] > *').first()).toBeVisible();
      await card.screenshot({
        path: path.join(SHOTS, theme, `${name}.png`),
        animations: 'disabled',
      });
    }
    expect(errors).toEqual([]);
  });

  test(`reference previews in ${theme} (screenshots for side-by-side review)`, async ({ page }) => {
    await offline(page);
    for (const name of CARDS) {
      await openPreview(page, name);
      await page.locator('html').evaluate((html, t) => html.setAttribute('data-theme', t), theme);
      await page.locator('#root').screenshot({
        path: path.join(SHOTS, theme, `${name}.reference.png`),
        animations: 'disabled',
      });
    }
  });
}

test('every card has the same DOM as its reference preview', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  const gallery = await context.newPage();
  const preview = await context.newPage();
  await offline(gallery);
  await offline(preview);
  await openGallery(gallery, 'dark');

  for (const name of CARDS) {
    await openPreview(preview, name);
    const want = await normalisedRoot(preview, '#root');
    const got = await normalisedRoot(gallery, `[data-card="${name}"] [data-preview-root]`);
    expect(want.html.length, `${name}: preview rendered`).toBeGreaterThan(100);
    expect(got.cls, `${name}: root class`).toBe(want.cls);
    expect(got.html, `${name}: DOM`).toBe(want.html);
  }
  await context.close();
});

test('status shows shape and text, never colour alone', async ({ page }) => {
  await offline(page);
  await openGallery(page, 'dark');
  const dots = page.locator('[data-card="StatusDot"] .hz-status');
  await expect(dots).toHaveText(['UP', 'WARN', 'DOWN', 'OFF', 'INFO', 'BOOT']);
  await expect(dots.nth(2)).toHaveAttribute('title', 'Ausgefallen');
  // Dense lists keep the long form for screen readers.
  await expect(page.locator('[data-card="ServerList"] .hz-sr')).toHaveText([
    'Läuft',
    'Warnung',
    'Läuft',
    'Ausgefallen',
  ]);
});

test('theme switch and controls work with the keyboard and show the focus ring', async ({
  page,
}) => {
  await offline(page);
  await openGallery(page, 'dark');

  const light = page.getByRole('button', { name: 'Hell' });
  await light.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(light).toHaveAttribute('aria-pressed', 'true');

  // Tab from the theme switch reaches the next control and paints the focus ring.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Wand' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Wand' })).not.toHaveCSS('box-shadow', 'none');

  // Toggle: Space flips the switch.
  const toggle = page.getByRole('switch', { name: 'Server-Steckdose' });
  await toggle.focus();
  await expect(toggle).not.toHaveCSS('box-shadow', 'none');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // ServerSwitch: Enter selects a tab.
  const tab = page.locator('[data-card="ServerSwitch"]').getByRole('tab', { name: /oracle-a1/ });
  await tab.focus();
  await page.keyboard.press('Enter');
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  // GameTemplates: Enter picks a template.
  const tpl = page.locator('[data-card="GameTemplates"] .hz-tpl').nth(2);
  await tpl.focus();
  await page.keyboard.press('Enter');
  await expect(tpl).toHaveClass(/hz-tpl-on/);
});
