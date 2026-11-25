import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const workspaces = [
  'apps/core',
  'apps/web',
  'apps/agent',
  'apps/share',
  'packages/shared',
  'packages/ui',
];

interface PackageJson {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
}

interface TsConfig {
  extends?: string;
  compilerOptions?: { strict?: boolean };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

describe('workspace layout', () => {
  it('uses strict TypeScript in the shared base config', () => {
    expect(readJson<TsConfig>('tsconfig.base.json').compilerOptions?.strict).toBe(true);
  });

  it('pins the package manager', () => {
    expect(readJson<{ packageManager?: string }>('package.json').packageManager).toMatch(
      /^pnpm@10\./,
    );
  });

  it.each(workspaces)('%s is an ESM package with a typecheck script', (dir) => {
    const pkg = readJson<PackageJson>(`${dir}/package.json`);
    expect(pkg.name).toMatch(/^@hz\//);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts?.typecheck).toBeDefined();
  });

  it.each(workspaces)('%s extends the strict base config', (dir) => {
    expect(existsSync(join(root, dir, 'tsconfig.json'))).toBe(true);
    expect(readJson<TsConfig>(`${dir}/tsconfig.json`).extends).toBe('../../tsconfig.base.json');
  });
});
