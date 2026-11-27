import type { AppTemplateDetail, AppTemplateSummary, InstalledApp } from '@hz/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../test-fixtures.js';
import { ApiError, configureApi } from './api.js';
import { errorText } from './errors.js';
import {
  appErrorText,
  appStatus,
  appStatusText,
  appsSentence,
  checkParam,
  draftToInstall,
  draftToTemplate,
  emptyTemplateDraft,
  groupTemplates,
  paramDefaults,
  portsText,
  removeApp,
  serverChoice,
  suggestAppId,
  templateToDraft,
} from './apps.js';

afterEach(() => vi.unstubAllGlobals());

function summary(over: Partial<AppTemplateSummary> = {}): AppTemplateSummary {
  return {
    id: 'jellyfin',
    source: 'builtin',
    name: 'Jellyfin',
    description: 'Filme und Serien streamen',
    category: 'medien',
    version: '10.10.3',
    arch: ['amd64', 'arm64'],
    minRamMb: 512,
    installed: 0,
    ...over,
  };
}

const tpl: AppTemplateDetail = {
  source: 'builtin',
  compose: 'services: {}',
  meta: {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Passwort-Manager',
    category: 'sicherheit',
    version: '1.32.5',
    arch: ['amd64'],
    minRamMb: 64,
    hints: [],
    params: [
      {
        type: 'port',
        key: 'WEB_PORT',
        label: 'Web-Port',
        default: 8081,
        protocol: 'tcp',
        web: true,
      },
      { type: 'password', key: 'ADMIN_TOKEN', label: 'Admin-Token', generate: true, minLength: 12 },
      { type: 'bool', key: 'SIGNUPS', label: 'Registrierung offen', default: false },
      {
        type: 'select',
        key: 'LOG_LEVEL',
        label: 'Log',
        options: [
          { value: 'warn', label: 'Warnungen' },
          { value: 'info', label: 'Info' },
        ],
        default: 'warn',
      },
      { type: 'string', key: 'DOMAIN', label: 'Domain', required: false, pattern: '[a-z.]+' },
      { type: 'number', key: 'WORKERS', label: 'Worker', default: 2, min: 1, max: 8 },
    ],
  },
};

function app(over: Partial<InstalledApp> = {}): InstalledApp {
  return {
    id: 'app-00000001',
    appId: 'jellyfin',
    name: 'Jellyfin',
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    templateId: 'jellyfin',
    source: 'builtin',
    templateName: 'Jellyfin',
    version: '10.10.3',
    bind: 'tailnet',
    ports: [{ port: 8096, protocol: 'tcp', label: 'Web' }],
    url: 'http://heimserver:8096',
    status: 'running',
    params: {},
    hasSecrets: false,
    containers: [{ name: 'jellyfin', state: 'running', health: 'healthy' }],
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
    ...over,
  };
}

describe('catalog', () => {
  it('groups by category in the fixed order and searches', () => {
    const list = [
      summary(),
      summary({
        id: 'vaultwarden',
        name: 'Vaultwarden',
        category: 'sicherheit',
        description: 'Passwörter',
      }),
      summary({ id: 'navidrome', name: 'Navidrome', description: 'Musik' }),
    ];
    const groups = groupTemplates(list, '');
    expect(groups.map((g) => g.label)).toEqual(['Medien', 'Passwörter und Sicherheit']);
    expect(groups[0]?.templates.map((t) => t.name)).toEqual(['Jellyfin', 'Navidrome']);
    expect(groupTemplates(list, 'passw').map((g) => g.category)).toEqual(['sicherheit']);
    expect(groupTemplates(list, 'medien musik')[0]?.templates.map((t) => t.id)).toEqual([
      'navidrome',
    ]);
    expect(groupTemplates(list, 'nichts')).toEqual([]);
  });

  it('offers only servers with a fitting architecture', () => {
    expect(serverChoice(server({ name: 'pi', arch: 'aarch64' }), tpl.meta)).toMatchObject({
      label: 'pi · läuft nicht auf arm64',
      disabled: true,
    });
    expect(serverChoice(server({ name: 'heim', arch: 'x64' }), tpl.meta)).toMatchObject({
      label: 'heim · amd64',
      disabled: false,
    });
    expect(serverChoice(server({ name: 'alt', connected: false }), tpl.meta).disabled).toBe(true);
    expect(serverChoice(server({ name: 'neu', arch: null }), tpl.meta).disabled).toBe(false);
  });

  it('suggests a free folder name', () => {
    const apps = [app(), app({ appId: 'jellyfin-2' }), app({ serverId: 'other', appId: 'x' })];
    expect(suggestAppId('jellyfin', 'srv-home0001', apps)).toBe('jellyfin-3');
    expect(suggestAppId('jellyfin', 'other', apps)).toBe('jellyfin');
  });
});

describe('install form', () => {
  it('fills defaults and builds the request', () => {
    const params = paramDefaults(tpl.meta.params);
    expect(params).toEqual({
      WEB_PORT: '8081',
      ADMIN_TOKEN: '',
      SIGNUPS: false,
      LOG_LEVEL: 'warn',
      DOMAIN: '',
      WORKERS: '2',
    });
    const res = draftToInstall(
      { serverId: 'srv-1', appId: 'vaultwarden', name: ' Vaultwarden ', bind: 'tailnet', params },
      tpl,
    );
    expect(res).toEqual({
      ok: true,
      body: {
        templateId: 'vaultwarden',
        serverId: 'srv-1',
        appId: 'vaultwarden',
        name: 'Vaultwarden',
        bind: 'tailnet',
        // Empty password is generated by the core, empty optional string takes the default.
        params: { WEB_PORT: 8081, SIGNUPS: false, LOG_LEVEL: 'warn', WORKERS: 2 },
      },
    });
  });

  it('checks every parameter type', () => {
    const [port, pw, , select, str, num] = tpl.meta.params;
    if (!port || !pw || !select || !str || !num) throw new Error('fixture');
    expect(checkParam(port, '80').error).toBe('1024 bis 65535');
    expect(checkParam(pw, 'kurz').error).toBe('Mindestens 12 Zeichen.');
    expect(checkParam(pw, 'geheim$geheim1').error).toBe('Ohne $ und ohne Zeilenumbruch.');
    expect(checkParam(str, 'a\nb').error).toBe('Ohne $ und ohne Zeilenumbruch.');
    expect(checkParam(str, 'EXAMPLE').error).toBe('Format passt nicht.');
    expect(checkParam(str, 'vault.example.com')).toEqual({
      error: null,
      value: 'vault.example.com',
    });
    expect(checkParam(select, 'debug').error).toBe('Auswahl treffen.');
    expect(checkParam(num, '9').error).toBe('1 bis 8');
    const res = draftToInstall(
      { serverId: '', appId: 'Bad Name', name: '', bind: 'all', params: { WEB_PORT: 'x' } },
      tpl,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.serverId).toBe('Server wählen.');
    expect(res.errors.appId).toContain('Kleinbuchstaben');
    expect(res.errors.name).toBe('1 bis 60 Zeichen.');
    expect(res.errors.params?.WEB_PORT).toBe('1024 bis 65535');
  });
});

describe('installed apps', () => {
  it('status with shape and text', () => {
    expect(appStatus(app())).toBe('ok');
    expect(appStatusText(app())).toBe('läuft');
    const sick = app({ containers: [{ name: 'jf', state: 'running', health: 'unhealthy' }] });
    expect(appStatus(sick)).toBe('warn');
    expect(appStatusText(sick)).toBe('läuft · 1 Container mit Problem');
    expect(appStatus(app({ status: 'stopped' }))).toBe('off');
    expect(appStatus(app({ status: 'installing' }))).toBe('busy');
    expect(appStatus(app({ status: 'error' }))).toBe('crit');
    expect(portsText(app().ports)).toBe('8096/tcp Web');
    expect(portsText([])).toBe('keine Ports');
    expect(appsSentence([app(), app({ id: 'b', name: 'Nextcloud', status: 'error' })])).toEqual({
      em: 'Nextcloud auf heimserver: Fehler',
      rest: ' · 1 von 2 Apps laufen',
    });
    expect(appsSentence([]).rest).toBe('Noch keine Apps installiert.');
  });

  it('error texts: own codes, the core message for an unsafe template', () => {
    const fallback = (e: unknown): string => errorText(e);
    expect(appErrorText(new ApiError(409, 'exists'), fallback)).toBe('Kennung schon vergeben.');
    expect(appErrorText(new ApiError(409, 'in_use'), fallback)).toContain('noch installiert');
    const unsafe = new ApiError(400, 'invalid_input', undefined, 'web: privileged ist verboten');
    expect(appErrorText(unsafe, fallback)).toBe('web: privileged ist verboten');
  });

  it('remove sends the typed name, delete flag and repeats after the code', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    const reset = configureApi({ onStepUp });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'step_up_required' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await removeApp('app-00000001', 'jellyfin', true);
    } finally {
      reset();
    }
    expect(onStepUp).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe('/api/apps/app-00000001');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBe(JSON.stringify({ confirmName: 'jellyfin', deleteData: true }));
  });
});

describe('template editor', () => {
  it('the example template is valid', () => {
    const d = {
      ...emptyTemplateDraft(),
      id: 'meine-app',
      name: 'Meine App',
      description: 'Test',
      version: '1.0',
    };
    const res = draftToTemplate(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.meta.params[0]).toMatchObject({ type: 'port', key: 'WEB_PORT', web: true });
    expect(
      templateToDraft({
        source: 'custom',
        meta: res.body.meta as AppTemplateDetail['meta'],
        compose: res.body.compose,
      }).id,
    ).toBe('meine-app');
  });

  it('shows German errors per field', () => {
    const res = draftToTemplate({
      ...emptyTemplateDraft(),
      id: 'Bad',
      name: '',
      description: '',
      amd64: false,
      arm64: false,
      minRamMb: '1',
      website: 'http://example.com',
      params: '[{ "type": "port", "key": "BIND", "label": "x", "default": 8080 }]',
      compose: '',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toMatchObject({
      id: 'Kleinbuchstaben, Ziffern und -, 2 bis 40 Zeichen.',
      name: '1 bis 40 Zeichen.',
      description: '1 bis 300 Zeichen.',
      arch: 'Mindestens eine Architektur.',
      minRamMb: '16 bis 65536 MB.',
      website: 'https-Adresse, höchstens 200 Zeichen.',
      compose: 'compose.yml eintragen.',
    });
    expect(res.errors.params).toBe(
      'Parameter 1 (BIND): Schlüssel in GROSSBUCHSTABEN, nicht APP_ID, APP_DIR, BIND, TZ, PUID, PGID.',
    );
    const json = draftToTemplate({ ...emptyTemplateDraft(), params: '[{' });
    expect(!json.ok && json.errors.params).toBe('Kein gültiges JSON. Beispiel siehe Hinweis.');
    const dup = draftToTemplate({
      ...emptyTemplateDraft(),
      id: 'x1',
      name: 'x',
      description: 'x',
      params:
        '[{"type":"bool","key":"A","label":"a","default":true},{"type":"bool","key":"A","label":"b","default":false}]',
    });
    expect(!dup.ok && dup.errors.params).toBe('Jeder Schlüssel nur einmal.');
  });
});
