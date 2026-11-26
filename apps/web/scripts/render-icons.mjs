// One-off: render PWA icons from design/assets/Logos/hz-mark.svg with Chromium.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Usage: node apps/web/scripts/render-icons.mjs "$PWD" (from the repo root)
const root = process.argv[2] ?? process.cwd();
const svg = readFileSync(`${root}/design/assets/Logos/hz-mark.svg`, 'utf8').replace(
  /<metadata>[\s\S]*<\/metadata>/,
  '',
);
const bg = '#0b0d10'; // bg-000 dark, design/tokens.json
const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, scale] of [
  ['icon-192', 192, 0.8],
  ['icon-512', 512, 0.8],
  ['icon-maskable-512', 512, 0.6],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * scale);
  await page.setContent(
    `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px"><img src="${url}" width="${inner}" height="${inner}"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.screenshot({ path: `${root}/apps/web/public/icons/${name}.png` });
}
await browser.close();
