import { describe, expect, it } from 'vitest';
import {
  haConfigNeedsStepUp,
  haConfigSchema,
  haEntityIdSchema,
  haKindAllowed,
  haPressRequestSchema,
  haSettingsRequestSchema,
  haUrlIsLinkLocal,
  haUrlSchema,
  type HaConfig,
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

  it('config step-up: new switch, new button or a changed kind; renames stay easy', () => {
    const e = (
      entityId: string,
      kind: HaConfig['entities'][number]['kind'],
      label: string | null = null,
    ) => ({ entityId, kind, roomId: null, label, overview: false });
    const prev = { entities: [e('switch.haustuer', 'button'), e('light.flur', 'toggle')] };
    // The attack: the door opener becomes a toggle.
    expect(
      haConfigNeedsStepUp(prev, {
        entities: [e('switch.haustuer', 'toggle'), e('light.flur', 'toggle')],
      }),
    ).toBe(true);
    // Removing and re-adding as toggle in a second save is a new switch.
    expect(haConfigNeedsStepUp({ entities: [] }, { entities: [e('switch.x', 'toggle')] })).toBe(
      true,
    );
    expect(
      haConfigNeedsStepUp({ entities: [] }, { entities: [e('button.klingel', 'button')] }),
    ).toBe(true);
    expect(
      haConfigNeedsStepUp(prev, { entities: [...prev.entities, e('light.bad', 'toggle')] }),
    ).toBe(false);
    expect(
      haConfigNeedsStepUp(prev, {
        entities: [e('light.flur', 'toggle', 'Flur'), e('switch.haustuer', 'button', 'Tür')],
      }),
    ).toBe(false);
    expect(haConfigNeedsStepUp(prev, { entities: [] })).toBe(false);
  });

  it('HA URLs must not point to link-local (cloud metadata); loopback is fine', () => {
    for (const u of [
      'http://169.254.169.254',
      'http://169.254.0.1:8123/',
      'http://2852039166',
      'http://0xa9.254.169.254',
      'http://[fe80::1]:8123',
      'http://[febf::1]',
      'http://[::ffff:169.254.169.254]',
    ]) {
      expect(haUrlIsLinkLocal(u), u).toBe(true);
      expect(haUrlSchema.safeParse(u).success, u).toBe(false);
    }
    for (const u of [
      'http://127.0.0.1:8123',
      'http://[::1]:8123',
      'http://192.168.68.20:8123',
      'https://ha.example.ts.net',
      'http://[fec0::1]',
    ]) {
      expect(haUrlSchema.safeParse(u).success, u).toBe(true);
    }
  });
});
