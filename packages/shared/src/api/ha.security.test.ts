import { describe, expect, it } from 'vitest';
import {
  haConfigSchema,
  haEntityIdSchema,
  haKindAllowed,
  haPressRequestSchema,
  haSettingsRequestSchema,
} from './ha.js';

describe('ha schemas', () => {
  it('entity ids are domain.object_id only', () => {
    expect(haEntityIdSchema.safeParse('light.wohnzimmer').success).toBe(true);
    for (const id of [
      'light',
      'Light.x',
      'light.x y',
      'light.x/../y',
      'homeassistant.restart()',
      '.x',
    ]) {
      expect(haEntityIdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('kinds are bound to domains: a door opener is never a toggle source of arbitrary services', () => {
    expect(haKindAllowed('toggle', 'light.flur')).toBe(true);
    expect(haKindAllowed('toggle', 'lock.haustuer')).toBe(false);
    expect(haKindAllowed('button', 'lock.haustuer')).toBe(true);
    expect(haKindAllowed('button', 'light.flur')).toBe(false);
    expect(haKindAllowed('metric', 'automation.x')).toBe(false);
    expect(haKindAllowed('toggle', 'homeassistant.restart')).toBe(false);
  });

  it('config refuses unknown rooms, duplicates and wrong kinds', () => {
    const room = { id: 'wohnzimmer', name: 'Wohnzimmer' };
    const e = {
      entityId: 'light.a',
      kind: 'toggle',
      roomId: 'wohnzimmer',
      label: null,
      overview: true,
    };
    expect(haConfigSchema.safeParse({ rooms: [room], entities: [e] }).success).toBe(true);
    expect(haConfigSchema.safeParse({ rooms: [], entities: [e] }).success).toBe(false);
    expect(haConfigSchema.safeParse({ rooms: [room], entities: [e, e] }).success).toBe(false);
    expect(
      haConfigSchema.safeParse({ rooms: [room], entities: [{ ...e, entityId: 'lock.tuer' }] })
        .success,
    ).toBe(false);
  });

  it('press needs an explicit confirm, settings URLs carry no credentials', () => {
    expect(haPressRequestSchema.safeParse({}).success).toBe(false);
    expect(haPressRequestSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(haPressRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(haSettingsRequestSchema.safeParse({ url: 'http://192.168.68.20:8123' }).success).toBe(
      true,
    );
    for (const url of [
      'http://u:p@ha.local:8123',
      'ftp://ha.local',
      'http://ha.local/?x=1',
      'javascript:alert(1)',
    ]) {
      expect(haSettingsRequestSchema.safeParse({ url }).success).toBe(false);
    }
  });
});
