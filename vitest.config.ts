import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript sources under this condition,
// so tests never depend on a prior build of packages/shared.
const conditions = ['@hz/source', 'module', 'node'];

const packages = [
  'apps/core',
  'apps/agent',
  'apps/share',
  'apps/web',
  'packages/shared',
  'packages/ui',
];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'workspace', include: ['test/**/*.test.ts'] } },
      ...packages.map((dir) => ({
        extends: true,
        test: {
          name: dir.slice(dir.indexOf('/') + 1),
          root: dir,
          include: ['{src,test,ui}/**/*.test.{ts,tsx}'],
        },
      })),
    ],
  },
});
