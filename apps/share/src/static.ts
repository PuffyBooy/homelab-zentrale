import fs from 'node:fs';
import path from 'node:path';

/** Fixed MIME allowlist. Anything else in the UI build is not served. */
export const MIME: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;

export interface StaticFile {
  body: Buffer;
  type: string;
}

export interface UiFiles {
  index: Buffer | null;
  assets: ReadonlyMap<string, StaticFile>;
}

/**
 * Loads the mini UI once at start-up into memory. Requests are answered by an exact
 * lookup in this map, so no request path ever reaches the filesystem (no traversal).
 * Only regular files directly in `<uiDir>/assets` (no symlinks, no subfolders) with an
 * allowlisted extension are loaded.
 */
export function loadUi(uiDir: string, warn: (msg: string) => void = () => {}): UiFiles {
  let index: Buffer | null = null;
  const assets = new Map<string, StaticFile>();
  let root: string;
  try {
    root = fs.realpathSync(uiDir);
  } catch {
    warn('UI-Ordner nicht gefunden');
    return { index, assets };
  }
  const indexPath = path.join(root, 'index.html');
  try {
    const st = fs.lstatSync(indexPath);
    if (st.isFile() && st.size <= MAX_FILE) index = fs.readFileSync(indexPath);
  } catch {
    // reported below
  }
  if (!index) warn('index.html fehlt im UI-Ordner');

  const assetsDir = path.join(root, 'assets');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(assetsDir, { withFileTypes: true });
  } catch {
    return { index, assets };
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile() || !ASSET_NAME.test(e.name) || e.name.includes('..')) continue;
    const type = MIME[path.extname(e.name).toLowerCase()];
    if (!type) continue;
    const file = path.join(assetsDir, e.name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL) continue;
    total += st.size;
    assets.set(e.name, { body: fs.readFileSync(file), type });
  }
  return { index, assets };
}
