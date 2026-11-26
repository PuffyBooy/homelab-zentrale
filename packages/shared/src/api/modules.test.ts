import { describe, expect, it } from 'vitest';
import { MODULE_DEFAULTS, MODULES, modulesSchema, modulesUpdateRequestSchema } from './modules.js';

describe('modules', () => {
  it('the schema has exactly the modules of MODULES', () => {
    expect(Object.keys(modulesSchema.shape).sort()).toEqual([...MODULES].sort());
    expect(Object.keys(MODULE_DEFAULTS).sort()).toEqual([...MODULES].sort());
  });

  it('update needs at least one known module, booleans only', () => {
    expect(modulesUpdateRequestSchema.safeParse({ github: true }).success).toBe(true);
    expect(modulesUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(modulesUpdateRequestSchema.safeParse({ shell: true }).success).toBe(false);
    expect(modulesUpdateRequestSchema.safeParse({ games: 'yes' }).success).toBe(false);
  });
});
