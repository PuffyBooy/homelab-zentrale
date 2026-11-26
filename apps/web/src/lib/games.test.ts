import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, game, server, template } from '../test-fixtures.js';
import { configureApi, isApiError } from './api.js';
import {
  applyGameEvents,
  consoleLines,
  dropEntry,
  findGameContainer,
  sendRcon,
  settleEntry,
  stampedLogLines,
  deleteConfirmed,
  disabledTileActions,
  draftFromValues,
  emptyCreateDraft,
  externalAddressError,
  fieldDefaults,
  forwardPlace,
  forwardRules,
  gamePorts,
  gameSentence,
  gameSnapshotToBuffer,
  gamesSentence,
  gameTileProps,
  historyStep,
  parseNumber,
  portLabel,
  progressLines,
  pushHistory,
  ramDetail,
  ramRange,
  settingsDraft,
  setupState,
  sortGames,
  suggestName,
  validateCreate,
  validateFields,
  validatePorts,
  validateSettings,
  emptyGameEvents,
  withoutError,
  type GameEvent,
} from './games.js';

const ev = (
  id: string,
  kind: GameEvent['kind'],
  text: string,
  ts = '2026-11-26T22:00:00.000Z',
) => ({
  id,
  kind,
  text,
  ts,
});

describe('form generator: defaults', () => {
  it('takes the template defaults, numbers as text, booleans as booleans', () => {
    expect(fieldDefaults(template().fields)).toEqual({
      TYPE: 'PAPER',
      VERSION: 'LATEST',
      MAX_PLAYERS: '20',
      SEED: '',
      ENABLE_WHITELIST: true,
    });
  });

  it('fills a settings draft from saved values, falling back to defaults', () => {
    const d = draftFromValues(template().fields, {
      MAX_PLAYERS: 10.5,
      TYPE: 'FABRIC',
      ENABLE_WHITELIST: false,
    });
    expect(d).toMatchObject({
      MAX_PLAYERS: '10,5',
      TYPE: 'FABRIC',
      ENABLE_WHITELIST: false,
      VERSION: 'LATEST',
    });
  });
});

describe('form generator: validation', () => {
  const fields = template().fields;

  it('accepts the defaults and types the values', () => {
    const r = validateFields(fields, fieldDefaults(fields));
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({
      TYPE: 'PAPER',
      VERSION: 'LATEST',
      MAX_PLAYERS: 20,
      SEED: '',
      ENABLE_WHITELIST: true,
    });
  });

  it('rejects a select value outside the options', () => {
    const r = validateFields(fields, { ...fieldDefaults(fields), TYPE: 'FORGE' });
    expect(r.errors.TYPE).toBe('Bitte einen Eintrag aus der Liste wählen.');
    expect(r.values.TYPE).toBeUndefined();
  });

  it('keeps boolean false and falls back to the default for missing booleans', () => {
    expect(
      validateFields(fields, { ...fieldDefaults(fields), ENABLE_WHITELIST: false }).values
        .ENABLE_WHITELIST,
    ).toBe(false);
    const d = fieldDefaults(fields);
    delete d.ENABLE_WHITELIST;
    expect(validateFields(fields, d).values.ENABLE_WHITELIST).toBe(true);
  });

  it('checks number ranges, comma decimals and required numbers', () => {
    const base = fieldDefaults(fields);
    expect(validateFields(fields, { ...base, MAX_PLAYERS: '0' }).errors.MAX_PLAYERS).toBe(
      'Zahl von 1 bis 100.',
    );
    expect(validateFields(fields, { ...base, MAX_PLAYERS: '101' }).errors.MAX_PLAYERS).toBe(
      'Zahl von 1 bis 100.',
    );
    expect(
      validateFields(fields, { ...base, MAX_PLAYERS: 'zwanzig' }).errors.MAX_PLAYERS,
    ).toBeDefined();
    expect(validateFields(fields, { ...base, MAX_PLAYERS: '' }).errors.MAX_PLAYERS).toBeDefined();
    expect(validateFields(fields, { ...base, MAX_PLAYERS: '12,5' }).values.MAX_PLAYERS).toBe(12.5);
    expect(validateFields(fields, { ...base, MAX_PLAYERS: ' 8 ' }).values.MAX_PLAYERS).toBe(8);
  });

  it('needs at least 8 characters for a non-empty secret', () => {
    const f = [
      {
        key: 'SERVER_PASS',
        label: 'Server-Passwort',
        type: 'text' as const,
        default: '',
        secret: true,
        optional: true,
      },
    ];
    expect(validateFields(f, { SERVER_PASS: '' }).errors).toEqual({});
    expect(validateFields(f, { SERVER_PASS: 'kurz' }).errors.SERVER_PASS).toBe(
      'Mindestens 8 Zeichen.',
    );
    expect(validateFields(f, { SERVER_PASS: 'lang-genug' }).values.SERVER_PASS).toBe('lang-genug');
  });

  it('requires text unless optional and checks the anchored pattern', () => {
    const base = fieldDefaults(fields);
    expect(validateFields(fields, { ...base, VERSION: '  ' }).errors.VERSION).toBe('Pflichtfeld.');
    expect(validateFields(fields, { ...base, SEED: '' }).errors.SEED).toBeUndefined();
    const withPattern = [
      { key: 'WORLD', label: 'Welt', type: 'text' as const, default: 'a', pattern: '[a-z]+' },
    ];
    expect(validateFields(withPattern, { WORLD: 'abc' }).errors).toEqual({});
    // Anchored: a partial match is not enough.
    expect(validateFields(withPattern, { WORLD: 'abc1' }).errors.WORLD).toBe('Format passt nicht.');
    expect(validateFields(withPattern, { WORLD: 'x'.repeat(201) }).errors.WORLD).toBe(
      'Höchstens 200 Zeichen.',
    );
  });

  it('only sends template keys', () => {
    const r = validateFields(fields, { ...fieldDefaults(fields), EVIL: 'x' });
    expect(Object.keys(r.values)).not.toContain('EVIL');
  });

  it('leaves out empty optional numbers', () => {
    const f = [
      { key: 'SLOTS', label: 'Slots', type: 'number' as const, default: 0, optional: true },
    ];
    expect(validateFields(f, { SLOTS: '' })).toEqual({ values: {}, errors: {} });
  });
});

describe('create form', () => {
  const tpl = template();

  it('builds the request body', () => {
    const d = {
      ...emptyCreateDraft(tpl, 'srv-1'),
      name: 'survival',
      externalAddress: ' mc.example.org ',
    };
    const r = validateCreate(tpl, d);
    expect(r).toEqual({
      ok: true,
      body: {
        templateId: 'minecraft-java',
        serverId: 'srv-1',
        name: 'survival',
        values: {
          TYPE: 'PAPER',
          VERSION: 'LATEST',
          MAX_PLAYERS: 20,
          SEED: '',
          ENABLE_WHITELIST: true,
        },
        ports: { game: 25565 },
        autoStopMinutes: 0,
        externalAddress: 'mc.example.org',
      },
    });
  });

  it('reports every error with its field key', () => {
    const d = {
      ...emptyCreateDraft(tpl),
      name: 'Survival World',
      ports: { game: '80' },
      autoStopMinutes: '-5',
      externalAddress: 'mc example',
      fields: { ...fieldDefaults(tpl.fields), MAX_PLAYERS: '0' },
    };
    const r = validateCreate(tpl, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual([
      'autoStopMinutes',
      'externalAddress',
      'field:MAX_PLAYERS',
      'name',
      'port:game',
      'serverId',
    ]);
    expect(r.errors.name).toBe('Nur Kleinbuchstaben, Ziffern und Bindestrich (2–32 Zeichen).');
  });

  it('rejects a name already used on the server', () => {
    const d = { ...emptyCreateDraft(tpl, 'srv-1'), name: 'survival' };
    const r = validateCreate(tpl, d, ['survival']);
    expect(r.ok ? null : r.errors.name).toBe('Diesen Namen gibt es auf dem Server schon.');
  });

  it('suggests a free name', () => {
    expect(suggestName(tpl, [])).toBe('minecraft-java');
    expect(suggestName(tpl, ['minecraft-java', 'minecraft-java-2'])).toBe('minecraft-java-3');
  });

  it('checks port ranges and overlaps (Valheim uses three ports)', () => {
    const ports = [
      { name: 'game', protocol: 'udp' as const, default: 2456, count: 3, local: false },
      { name: 'extra', protocol: 'tcp' as const, default: 2460, count: 1, local: false },
    ];
    expect(validatePorts(ports, { game: '2456', extra: '2460' })).toEqual({
      ports: { game: 2456, extra: 2460 },
      errors: {},
    });
    expect(validatePorts(ports, { game: '2456', extra: '2458' }).errors['port:extra']).toBe(
      'Port doppelt belegt.',
    );
    expect(validatePorts(ports, { game: '65534', extra: '2460' }).errors['port:game']).toBe(
      'Port von 1024 bis 65533.',
    );
    expect(validatePorts(ports, { game: '24,5', extra: '2460' }).errors['port:game']).toBeDefined();
  });

  it('checks external address and settings', () => {
    expect(externalAddressError('')).toBeNull();
    expect(externalAddressError('mc.example.org')).toBeNull();
    expect(externalAddressError('130.61.4.2:25565')).toBeNull();
    expect(externalAddressError('https://mc.example.org')).not.toBeNull();
    const s = validateSettings(tpl, {
      autoStopMinutes: '30',
      externalAddress: '',
      fields: fieldDefaults(tpl.fields),
    });
    expect(s.ok && s.body.autoStopMinutes).toBe(30);
    // Empty is sent, so the address can go back to the Tailscale IP.
    expect(s.ok && s.body.externalAddress).toBe('');
    expect(settingsDraft(game({ externalAddress: 'mc.example.org' }), tpl).externalAddress).toBe(
      'mc.example.org',
    );
    expect(
      validateSettings(tpl, { autoStopMinutes: '1441', externalAddress: '', fields: {} }).ok,
    ).toBe(false);
  });

  it('leaves an empty secret field out of the settings, so the stored one stays', () => {
    const fields = [
      {
        key: 'SERVER_PASS',
        label: 'Passwort',
        type: 'text' as const,
        default: '',
        secret: true,
        optional: true,
      },
      { key: 'MOTD', label: 'MOTD', type: 'text' as const, default: '', optional: true },
    ];
    const s = validateSettings(
      { fields },
      {
        autoStopMinutes: '0',
        externalAddress: '',
        fields: { SERVER_PASS: '', MOTD: '' },
      },
    );
    expect(s.ok && s.body.values).toEqual({ MOTD: '' });
  });

  it('parses numbers strictly', () => {
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('1e3')).toBeNaN();
    expect(parseNumber('')).toBeNaN();
  });
});

describe('delete confirmation', () => {
  it('needs the exact name', () => {
    expect(deleteConfirmed('survival', 'survival')).toBe(true);
    expect(deleteConfirmed(' survival ', 'survival')).toBe(true);
    expect(deleteConfirmed('Survival', 'survival')).toBe(false);
    expect(deleteConfirmed('surviva', 'survival')).toBe(false);
    expect(deleteConfirmed('', 'survival')).toBe(false);
  });
});

describe('status texts', () => {
  it('names problems first', () => {
    const list = [
      game({ name: 'survival' }),
      game({ name: 'valheim', status: 'crit', statusText: 'Container abgestürzt' }),
    ];
    expect(gamesSentence(list)).toEqual({
      em: 'valheim: Container abgestürzt',
      rest: ' · 2 Gameserver',
    });
    expect(
      gamesSentence([game({ status: 'crit' }), game({ status: 'crit' }), game({ status: 'warn' })])
        .em,
    ).toBe('2 Gameserver ausgefallen');
    expect(gamesSentence([game({ name: 'a', status: 'warn', statusText: 'TPS 12' })]).em).toBe(
      'a: TPS 12',
    );
  });

  it('shows setups, then what runs and who plays', () => {
    expect(gamesSentence([]).rest).toBe('Noch keine Gameserver.');
    expect(
      gamesSentence([
        game({ name: 'neu', status: 'busy', statusText: 'Welt wird erzeugt' }),
        game(),
      ]).rest,
    ).toBe('neu: Welt wird erzeugt · 2 Gameserver');
    expect(gamesSentence([game(), game({ status: 'off', players: null })]).rest).toBe(
      '1 von 2 Gameservern läuft · 4 Spieler online',
    );
    expect(gamesSentence([game(), game()]).rest).toBe(
      'Alle 2 Gameserver laufen · 8 Spieler online',
    );
    expect(gamesSentence([game({ players: { online: 0, max: 10, names: [] } })]).rest).toBe(
      'Gameserver läuft',
    );
    expect(gamesSentence([game({ status: 'off' }), game({ status: 'off' })]).rest).toBe(
      'Alle 2 Gameserver gestoppt.',
    );
  });

  it('describes one game', () => {
    expect(gameSentence(game()).rest).toBe('survival läuft · 4 von 20 Spielern online');
    expect(gameSentence(game({ status: 'off' })).rest).toBe('survival ist gestoppt.');
    expect(gameSentence(game({ status: 'busy', statusText: 'Image wird geladen' })).rest).toBe(
      'survival: Image wird geladen',
    );
    expect(gameSentence(game({ status: 'crit', statusText: 'Container abgestürzt' }))).toEqual({
      em: 'survival: Container abgestürzt',
      rest: ' · oracle-a1',
    });
  });

  it('sorts problems first', () => {
    const list = sortGames([
      game({ name: 'b', status: 'off' }),
      game({ name: 'a' }),
      game({ name: 'z', status: 'crit' }),
      game({ name: 'c', status: 'busy' }),
    ]);
    expect(list.map((g) => g.name)).toEqual(['z', 'c', 'a', 'b']);
  });
});

describe('tile props', () => {
  it('formats RAM, TPS and players in the Austrian format', () => {
    const p = gameTileProps(game());
    expect(p.ramDetail).toBe('5,8 / 8 GB');
    expect(Math.round(p.ram ?? 0)).toBe(73);
    expect(p.tpsDetail).toBe('19,8');
    expect(p.players).toEqual([4, 20]);
    expect(p.online).toEqual(['Sam', 'Lukas', 'mia_07', 'Tobi']);
    expect(p.host).toBe('oracle-a1');
  });

  it('falls back to MAX_PLAYERS and the RAM limit while stopped', () => {
    const p = gameTileProps(game({ status: 'off', players: null, tps: null, ramBytes: null }));
    expect(p.players).toEqual([0, 20]);
    expect(p.ramDetail).toBe('— / 8 GB');
    expect(p.tpsDetail).toBe('—');
    expect(ramDetail({ ramBytes: null, ramLimitBytes: null })).toBe('—');
  });

  it('keeps share enabled and disables start/stop/restart while busy', () => {
    expect(disabledTileActions(game())).toEqual([]);
    expect(disabledTileActions(game({ status: 'busy' }))).toEqual(['start', 'stop', 'restart']);
  });
});

describe('ports and forwarding hint', () => {
  it('labels ports and ranges', () => {
    expect(portLabel(25565, 'tcp')).toBe('25565/TCP');
    expect(portLabel(2456, 'udp', 3)).toBe('2456–2458/UDP');
    expect(portLabel(27015, 'tcp+udp')).toBe('27015/TCP und UDP');
    expect(ramRange({ min: '4G', recommended: '6G' })).toBe('4–6 GB');
    expect(ramRange({ min: '2G', recommended: '2G' })).toBe('2 GB');
  });

  it('lists the exact rules with the template count', () => {
    const g = game({ ports: [{ name: 'game', port: 2456, protocol: 'udp' }] });
    const ports = gamePorts(
      g,
      template({
        ports: [{ name: 'game', protocol: 'udp', default: 2456, count: 3, local: false }],
      }),
    );
    expect(forwardRules(ports)).toEqual([{ name: 'game', ports: '2456–2458', protocol: 'UDP' }]);
  });

  it('guesses where to forward', () => {
    expect(forwardPlace(server({ name: 'oracle-a1', location: 'Frankfurt' }))).toBe('oracle');
    expect(forwardPlace(server({ name: 'heimserver', location: 'Zuhause' }))).toBe('home');
    expect(forwardPlace(server({ name: 'web-vps', location: 'Nürnberg' }))).toBe('unknown');
    expect(forwardPlace(undefined)).toBe('unknown');
  });
});

describe('live events of game:<id>', () => {
  it('dedupes, drops invalid items and accepts both snapshot shapes', () => {
    const a = applyGameEvents(emptyGameEvents, [
      ev('1', 'progress', 'Image wird geladen'),
      { bad: 1 },
    ]);
    const b = applyGameEvents(a, [ev('1', 'progress', 'doppelt'), ev('2', 'ready', 'bereit')]);
    expect(b.events.map((e) => e.id)).toEqual(['1', '2']);
    expect(gameSnapshotToBuffer({ events: [ev('3', 'console', 'x')] })?.events).toHaveLength(1);
    expect(gameSnapshotToBuffer([ev('3', 'console', 'x')])?.complete).toBe(true);
    expect(gameSnapshotToBuffer('nope')).toBeNull();
  });

  it('turns progress into lines and knows the setup state', () => {
    const list = [
      ev('1', 'progress', 'Image wird geladen\nWelt wird erzeugt\n'),
      ev('2', 'console', '[Server] Done'),
    ];
    expect(progressLines(list)).toEqual([
      { text: 'Image wird geladen' },
      { text: 'Welt wird erzeugt' },
    ]);
    expect(setupState(list)).toBe('running');
    const ready = [...list, ev('3', 'ready', 'bereit')];
    expect(setupState(ready)).toBe('ready');
    expect(progressLines(ready).at(-1)).toEqual({ text: 'bereit', kind: 'ok' });
    expect(setupState([...list, ev('4', 'error', 'Port belegt')])).toBe('error');
    expect(setupState([])).toBe('none');
  });

  it('merges console events and own commands in time order', () => {
    const lines = consoleLines(
      [ev('1', 'console', 'Sam joined', '2026-11-26T22:00:00.000Z'), ev('2', 'progress', 'x')],
      [
        {
          id: 'c1',
          ts: '2026-11-26T22:01:00.000Z',
          command: 'list',
          output: 'There are 1 of 20',
          error: null,
        },
        { id: 'c2', ts: '2026-11-26T22:02:00.000Z', command: 'tps', output: null, error: null },
        {
          id: 'c3',
          ts: '2026-11-26T22:03:00.000Z',
          command: 'x',
          output: null,
          error: 'Agent offline.',
        },
      ],
    );
    expect(lines).toEqual([
      { text: 'Sam joined' },
      { text: 'list', kind: 'cmd' },
      { text: 'There are 1 of 20' },
      { text: 'tps', kind: 'cmd' },
      { text: '…', kind: 'dim' },
      { text: 'x', kind: 'cmd' },
      { text: 'Agent offline.', kind: 'err' },
    ]);
  });
});

describe('console echo from the core', () => {
  it('hides an answered command once the core echoed it, keeps pending ones', () => {
    const events = [
      ev('1', 'console', '> list', '2026-11-26T22:01:01.000Z'),
      ev('2', 'console', 'There are 1 of 20', '2026-11-26T22:01:01.000Z'),
    ];
    const lines = consoleLines(events, [
      {
        id: 'c1',
        ts: '2026-11-26T22:01:00.000Z',
        command: 'list',
        output: 'There are 1 of 20',
        error: null,
      },
      { id: 'c2', ts: '2026-11-26T22:02:00.000Z', command: 'list', output: null, error: null },
    ]);
    expect(lines).toEqual([
      { text: 'list', kind: 'cmd' },
      { text: 'There are 1 of 20' },
      { text: 'list', kind: 'cmd' },
      { text: '…', kind: 'dim' },
    ]);
  });
});

describe('withoutError', () => {
  it('drops one key and keeps the object when it is missing', () => {
    const e = { name: 'x', serverId: 'y' };
    expect(withoutError(e, 'name')).toEqual({ serverId: 'y' });
    expect(withoutError(e, 'other')).toBe(e);
  });
});

describe('console history', () => {
  it('keeps commands without direct repeats', () => {
    expect(pushHistory(['list'], 'list')).toEqual(['list']);
    expect(pushHistory(['list'], ' tps ')).toEqual(['list', 'tps']);
    expect(pushHistory(['list'], '  ')).toEqual(['list']);
  });

  it('walks up to older commands and back down to the draft', () => {
    const h = ['list', 'tps', 'say hi'];
    let s = historyStep(h, 3, 'up', 'wh');
    expect(s).toEqual({ index: 2, value: 'say hi' });
    s = historyStep(h, s.index, 'up', 'wh');
    s = historyStep(h, s.index, 'up', 'wh');
    expect(s).toEqual({ index: 0, value: 'list' });
    expect(historyStep(h, 0, 'up', 'wh')).toEqual({ index: 0, value: 'list' });
    s = historyStep(h, 2, 'down', 'wh');
    expect(s).toEqual({ index: 3, value: 'wh' });
    expect(historyStep(h, 3, 'down', 'wh')).toEqual({ index: 3, value: 'wh' });
    expect(historyStep([], 0, 'up', 'wh')).toEqual({ index: 0, value: 'wh' });
  });
});

describe('console with the container log', () => {
  it('finds the game container by name game-<name> or compose project', () => {
    const g = game({ name: 'survival', serverId: 'srv-a' });
    const other = container({ serverId: 'srv-b', name: 'game-survival' });
    const byProject = container({ serverId: 'srv-a', name: 'mc', composeProject: 'survival' });
    const byName = container({ serverId: 'srv-a', name: 'game-survival' });
    expect(findGameContainer(g, [other, byProject, byName])).toBe(byName);
    expect(findGameContainer(g, [other, byProject])).toBe(byProject);
    expect(findGameContainer(g, [other])).toBeUndefined();
  });

  it('puts log history first and live log lines between console events', () => {
    const logs = stampedLogLines({
      lines: [
        { seq: 0, stream: 'stdout', text: 'Starting server' },
        { seq: 1, stream: 'stderr', text: 'Can not bind' },
        { seq: 2, stream: 'stdout', text: 'Sam joined the game' },
      ],
      ended: false,
      at: { 2: '2026-11-26T22:01:30.000Z' },
    });
    const lines = consoleLines(
      [
        ev('1', 'console', '> list', '2026-11-26T22:01:00.000Z'),
        ev('2', 'console', 'There are 0 of 20', '2026-11-26T22:01:00.000Z'),
      ],
      [{ id: 'c1', ts: '2026-11-26T22:02:00.000Z', command: 'tps', output: null, error: null }],
      logs,
    );
    expect(lines).toEqual([
      { text: 'Starting server' },
      { text: 'Can not bind', kind: 'err' },
      { text: 'list', kind: 'cmd' },
      { text: 'There are 0 of 20' },
      { text: 'Sam joined the game' },
      { text: 'tps', kind: 'cmd' },
      { text: '…', kind: 'dim' },
    ]);
  });
});

describe('RCON send and step-up', () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('goes through api(), so the global step-up dialog appears and the send repeats', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    const reset = configureApi({ onStepUp });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(403, { ok: false, error: 'step_up_required' }))
      .mockResolvedValueOnce(reply(200, { output: 'There are 0 of 20' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(sendRcon('game-000001', 'list')).resolves.toBe('There are 0 of 20');
    } finally {
      reset();
    }
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/games/game-000001/rcon');
  });

  it('a cancelled step-up rejects with step_up_required and the pending line goes away', async () => {
    const reset = configureApi({ onStepUp: () => Promise.resolve(false) });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(reply(403, { ok: false, error: 'step_up_required' })),
    );
    let err: unknown;
    try {
      await sendRcon('game-000001', 'list');
    } catch (e) {
      err = e;
    } finally {
      reset();
    }
    expect(isApiError(err, 'step_up_required')).toBe(true);

    const pending = { id: 'c1', ts: '2026-11-26T22:02:00.000Z', command: 'list' };
    const entries = [{ ...pending, output: null, error: null }];
    expect(consoleLines([], dropEntry(entries, 'c1'))).toEqual([]);
    expect(settleEntry(entries, 'c1', { output: 'ok' })[0]).toMatchObject({ output: 'ok' });
    expect(settleEntry(entries, 'c1', { error: 'Agent offline.' })[0]).toMatchObject({
      error: 'Agent offline.',
    });
  });
});
