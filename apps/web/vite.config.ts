import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Colours from design/tokens.json (dark theme), for the manifest only. */
const BG_000_DARK = '#0b0d10';

const GOOGLE_FONTS_IMPORT = /@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g;

/**
 * design/components.css imports the fonts from Google Fonts. The app self-hosts them
 * (src/styles/fonts.css), and the CSP allows no external hosts, so the import is removed.
 * The file is inlined by postcss-import, which does not go through Vite's transform hook,
 * so this runs as a PostCSS plugin (and as a transform for direct imports).
 */
function stripGoogleFonts(): Plugin {
  const postcssPlugin = {
    postcssPlugin: 'hz-strip-google-fonts',
    AtRule: {
      import: (rule: { params: string; remove: () => void }) => {
        if (rule.params.includes('fonts.googleapis.com')) rule.remove();
      },
    },
  };
  return {
    name: 'hz-strip-google-fonts',
    enforce: 'pre',
    config: () => ({ css: { postcss: { plugins: [postcssPlugin] } } }),
    transform(code, id) {
      if (!id.split('?')[0]?.endsWith('.css') || !code.includes('fonts.googleapis.com')) return;
      return { code: code.replace(GOOGLE_FONTS_IMPORT, ''), map: null };
    },
  };
}

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Writes `<file>.gz` and `<file>.br` next to every text asset in dist/ (the core serves
 * them when the browser accepts the encoding). Runs after the PWA plugin, so sw.js is
 * included. No dependency, only node:zlib.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hz-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        for (const file of walk(outDir)) {
          if (!COMPRESSIBLE.test(file)) continue;
          const data = readFileSync(file);
          if (data.length < 1024) continue;
          writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
          writeFileSync(
            `${file}.br`,
            brotliCompressSync(data, {
              params: {
                [zlib.BROTLI_PARAM_QUALITY]: 11,
                [zlib.BROTLI_PARAM_SIZE_HINT]: data.length,
              },
            }),
          );
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [
    stripGoogleFonts(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // External registerSW.js, no inline script (CSP script-src 'self').
      injectRegister: 'script',
      includeAssets: ['favicon.svg', 'fonts/*.woff2', 'icons/*.png'],
      manifest: {
        name: 'Homelab-Zentrale',
        short_name: 'Zentrale',
        description: 'Server, Container, Gameserver, Websites und Wohnung an einem Ort.',
        lang: 'de-AT',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: BG_000_DARK,
        background_color: BG_000_DARK,
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Offline shell only. API, live socket and share pages are never cached.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/live/, /^\/s\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // Push and notification clicks (public/sw-push.js), next to the generated precache.
        importScripts: ['/sw-push.js'],
      },
      devOptions: { enabled: false },
    }),
    precompress(),
  ],
  resolve: { conditions: ['@hz/source'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/live': { target: 'ws://127.0.0.1:8080', ws: true },
      // Only the WebSocket goes to the core; the page /console stays the SPA.
      '/console': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
        bypass: (req) => (req.headers.upgrade ? undefined : '/index.html'),
      },
    },
    fs: { allow: ['.', '../../design', '../../packages'] },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
