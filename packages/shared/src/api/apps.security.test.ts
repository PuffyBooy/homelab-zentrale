import { describe, expect, it } from 'vitest';
import {
  APP_RESERVED_KEYS,
  appInstallRequestSchema,
  appParamKeySchema,
  appParamValueSchema,
  appRemoveRequestSchema,
  appSecretsResponseSchema,
  appTemplateCustomRequestSchema,
  appTemplateIdSchema,
  appTemplateMetaSchema,
  COMPOSE_FORBIDDEN,
  fillPlaceholders,
  installedAppSchema,
} from './apps.js';

const SERVER = 'abcdefgh12345678';

const meta = {
  id: 'vaultwarden',
  name: 'Vaultwarden',
  description: 'Passwort-Manager',
  category: 'sicherheit',
  version: '1.32.0',
  arch: ['amd64', 'arm64'],
  minRamMb: 128,
  params: [
    { type: 'port', key: 'WEB_PORT', label: 'Port', default: 8081, web: true },
    { type: 'password', key: 'ADMIN_TOKEN', label: 'Admin-Token' },
  ],
};

describe('apps schema: template meta', () => {
  it('accepts a valid template', () => {
    expect(appTemplateMetaSchema.safeParse(meta).success).toBe(true);
  });

  it.each([
    ['duplicate param key', { ...meta, params: [meta.params[0], meta.params[0]] }],
    [
      'two web ports',
      {
        ...meta,
        params: [meta.params[0], { type: 'port', key: 'B', label: 'B', default: 9000, web: true }],
      },
    ],
    ['port below 1024', { ...meta, params: [{ type: 'port', key: 'P', label: 'P', default: 80 }] }],
    ['reserved key', { ...meta, params: [{ type: 'string', key: 'BIND', label: 'x' }] }],
    ['lower-case key', { ...meta, params: [{ type: 'string', key: 'bind', label: 'x' }] }],
    ['http website', { ...meta, website: 'http://example.org' }],
    ['unknown arch', { ...meta, arch: ['mips'] }],
    ['id with dots', { ...meta, id: '../x' }],
    ['too much RAM', { ...meta, minRamMb: 70_000 }],
    ['unknown field', { ...meta, privileged: true }],
  ])('rejects %s', (_n, v) => expect(appTemplateMetaSchema.safeParse(v).success).toBe(false));

  it('every reserved key is refused as a param key', () => {
    for (const k of APP_RESERVED_KEYS)
      expect(appParamKeySchema.safeParse(k).success, k).toBe(false);
  });

  it('custom template compose size is bounded', () => {
    expect(appTemplateCustomRequestSchema.safeParse({ meta, compose: '' }).success).toBe(false);
    expect(
      appTemplateCustomRequestSchema.safeParse({ meta, compose: 'x'.repeat(64 * 1024 + 1) })
        .success,
    ).toBe(false);
  });

  it('template ids', () => {
    for (const id of ['a', '-a', 'a-', 'A', 'a_b', 'a'.repeat(41)]) {
      expect(appTemplateIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe('apps schema: install', () => {
  const req = { templateId: 'vaultwarden', serverId: SERVER, appId: 'vaultwarden', name: 'Tresor' };
  it('defaults: bind tailnet, no params', () => {
    expect(appInstallRequestSchema.parse(req)).toMatchObject({ bind: 'tailnet', params: {} });
  });

  it.each(['a$b', '${X}', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(201)])(
    'parameter value %j is refused',
    (v) => {
      expect(appParamValueSchema.safeParse(v).success).toBe(false);
      expect(appInstallRequestSchema.safeParse({ ...req, params: { WEB_PORT: v } }).success).toBe(
        false,
      );
    },
  );

  it.each([
    ['folder traversal', { ...req, appId: '../etc' }],
    ['folder upper case', { ...req, appId: 'Vault' }],
    ['bind any address', { ...req, bind: '0.0.0.0' }],
    ['reserved param key', { ...req, params: { APP_DIR: '/' } }],
    ['object value', { ...req, params: { A: { x: 1 } } }],
    ['fractional number', { ...req, params: { A: 1.5 } }],
    ['unknown field', { ...req, privileged: true }],
  ])('rejects %s', (_n, v) => expect(appInstallRequestSchema.safeParse(v).success).toBe(false));

  it('remove needs the app id and keeps data by default', () => {
    expect(appRemoveRequestSchema.parse({ confirmName: 'vaultwarden' })).toEqual({
      confirmName: 'vaultwarden',
      deleteData: false,
    });
    expect(appRemoveRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('apps schema: responses and helpers', () => {
  it('installed apps carry no secret values, only hasSecrets', () => {
    const app = {
      id: 'abcdefgh',
      appId: 'vaultwarden',
      name: 'Tresor',
      serverId: SERVER,
      serverName: 'heimserver',
      templateId: 'vaultwarden',
      source: 'builtin',
      templateName: 'Vaultwarden',
      version: '1',
      bind: 'tailnet',
      ports: [],
      url: null,
      status: 'running',
      params: {},
      hasSecrets: true,
      containers: [],
      createdAt: 1,
      updatedAt: 1,
      lastError: null,
    };
    expect(installedAppSchema.safeParse(app).success).toBe(true);
    expect(installedAppSchema.safeParse({ ...app, secrets: { ADMIN_TOKEN: 'x' } }).success).toBe(
      false,
    );
    expect(appSecretsResponseSchema.safeParse({ values: { bad: 'x' } }).success).toBe(false);
  });

  it('fillPlaceholders replaces only known upper-case keys, once', () => {
    expect(fillPlaceholders('${BIND}:${PORT}:80', { BIND: '100.64.0.5', PORT: '8081' })).toBe(
      '100.64.0.5:8081:80',
    );
    expect(fillPlaceholders('${UNKNOWN} ${lower}', { BIND: 'x' })).toBe('${UNKNOWN} ${lower}');
    // A value that looks like a placeholder is not expanded again.
    expect(fillPlaceholders('${A}', { A: '${B}', B: 'boom' })).toBe('${B}');
    // Prototype keys are not values.
    expect(fillPlaceholders('${CONSTRUCTOR}', {})).toBe('${CONSTRUCTOR}');
  });

  it('the compose rules cover the security basics', () => {
    for (const rule of [
      'privileged',
      'docker.sock',
      'network_mode: host',
      'label hz.role',
      'absolute bind mounts',
    ]) {
      expect(COMPOSE_FORBIDDEN).toContain(rule);
    }
  });
});
