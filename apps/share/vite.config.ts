import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Mini UI of the share page (apps/share/ui) -> dist/ui, served under /s/ by the core
 * (tailnet) and by the gateway. Flat assets (dist/ui/assets/*), no source maps, nothing
 * inlined (strict CSP: script-src 'self', no data: fonts).
 */

const GOOGLE_FONTS_IMPORT = /@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g;

/** design/components.css imports Google Fonts; the page self-hosts them (no external requests). */
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

const dir = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: dir('./ui'),
  base: '/s/',
  publicDir: false,
  plugins: [stripGoogleFonts()],
  resolve: { conditions: ['@hz/source'] },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: { allow: [dir('../..')] },
  },
  build: {
    outDir: dir('./dist/ui'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    target: 'es2022',
  },
});
