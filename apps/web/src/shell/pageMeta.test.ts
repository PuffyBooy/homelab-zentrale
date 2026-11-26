import { describe, expect, it } from 'vitest';
import { alert, check, container, game, repo, server, target } from '../test-fixtures.js';
import {
  checkDetailId,
  containerLogsId,
  gameDetailId,
  needsGames,
  needsChecks,
  needsContainers,
  needsRepos,
  pageMeta,
  repoDetailId,
} from './pageMeta.js';

describe('pageMeta for containers', () => {
  const home = server({ id: 'srv-home0001', name: 'heimserver' });
  const bad = container({ name: 'lernplattform', status: 'crit', state: 'exited', exitCode: 1 });

  it('puts the problem first on /containers', () => {
    const meta = pageMeta('/containers', {
      servers: [home],
      containers: [container(), bad],
      live: 'open',
    });
    expect(meta.title).toEqual({
      em: 'lernplattform auf heimserver ist ausgefallen',
      rest: ' · 1 von 2 Containern läuft',
    });
    expect(meta.serverSwitch).toBe(true);
    expect(pageMeta('/containers', { servers: [home] }).sub).toBe('lädt …');
  });

  it('describes the container on its log page', () => {
    const path = `/containers/${bad.id}/logs`;
    expect(containerLogsId(path)).toBe(bad.id);
    expect(needsContainers(path)).toBe(true);
    expect(needsContainers('/servers')).toBe(false);
    const meta = pageMeta(path, { servers: [home], containers: [bad] });
    expect(meta.title).toEqual({ em: 'lernplattform ist ausgefallen', rest: ' · exit 1' });
    expect(meta.serverSwitch).toBe(false);
  });
});

describe('pageMeta for websites and alerts', () => {
  const home = server({ id: 'srv-home0001', name: 'heimserver' });
  const down = check({
    def: { url: 'https://lernen.hoebe.at/', serverId: home.id },
    status: 'crit',
    reason: 'HTTP 503',
  });

  it('puts the offline site first on /websites and filters by server', () => {
    expect(needsChecks('/websites')).toBe(true);
    expect(needsChecks('/servers')).toBe(false);
    expect(pageMeta('/websites', { servers: [home] }).sub).toBe('lädt …');
    const meta = pageMeta('/websites', { servers: [home], checks: [down, check()], live: 'open' });
    expect(meta.title).toEqual({
      em: 'lernen.hoebe.at ist nicht erreichbar',
      rest: ' · 1 von 2 Checks erreichbar',
    });
    expect(meta.sub).toBe('Websites · 2 Checks · live');
    expect(meta.serverSwitch).toBe(true);
    const one = pageMeta('/websites', {
      servers: [home],
      checks: [down, check()],
      filter: home.id,
    });
    expect(one.title.em).toBe('lernen.hoebe.at ist nicht erreichbar');
    expect(one.title.rest).toBe(' · 0 von 1 Check erreichbar');
  });

  it('describes one check on its detail page', () => {
    const path = `/websites/${down.id}`;
    expect(checkDetailId(path)).toBe(down.id);
    expect(needsChecks(path)).toBe(true);
    const meta = pageMeta(path, { servers: [home], checks: [down] });
    expect(meta.title).toEqual({ em: 'lernen.hoebe.at ist nicht erreichbar', rest: ' · HTTP 503' });
    expect(meta.sub).toBe('Website · HTTP(S) · von der Zentrale');
  });

  it('counts open alerts, also per server', () => {
    const alerts = [alert({ serverId: home.id }), alert(), alert({ state: 'acked' })];
    expect(pageMeta('/alerts', { servers: [home], alerts }).title.em).toBe('2 offene Meldungen');
    expect(pageMeta('/alerts', { servers: [home], alerts, filter: home.id }).title.em).toBe(
      '1 offene Meldung auf heimserver',
    );
    expect(pageMeta('/alerts', { servers: [home], alerts: [] }).title.rest).toBe(
      'Keine offenen Meldungen.',
    );
  });
});

describe('pageMeta for github', () => {
  const home = server({ id: 'srv-home0001', name: 'heimserver' });

  it('puts red CI first on /github and filters by target server', () => {
    const red = repo({ fullName: 'PuffyBooy/lernplattform', ci: 'crit' });
    const ok = repo({ fullName: 'PuffyBooy/soundos', targets: [target({ serverId: home.id })] });
    expect(needsRepos('/github')).toBe(true);
    expect(needsRepos('/servers')).toBe(false);
    expect(pageMeta('/github', { servers: [home] }).sub).toBe('lädt …');
    const meta = pageMeta('/github', { servers: [home], repos: [red, ok], live: 'open' });
    expect(meta.title).toEqual({ em: 'CI rot bei lernplattform', rest: ' · 2 Repos' });
    expect(meta.serverSwitch).toBe(true);
    const one = pageMeta('/github', { servers: [home], repos: [red, ok], filter: home.id });
    expect(one.title).toEqual({ em: null, rest: 'Alles aktuell · 1 Repo' });
  });

  it('describes the repo on its detail page', () => {
    const r = repo({ fullName: 'PuffyBooy/soundos', targets: [target({ behind: 3 })] });
    const path = `/github/${r.id}`;
    expect(repoDetailId(path)).toBe(r.id);
    expect(needsRepos(path)).toBe(true);
    const meta = pageMeta(path, { servers: [home], repos: [r] });
    expect(meta.title.rest).toBe('soundos: 3 neu, noch nicht deployt.');
    expect(meta.sub).toBe('GitHub · PuffyBooy/soundos · 1 Ziel');
    expect(meta.serverSwitch).toBe(false);
  });
});

describe('pageMeta for game servers', () => {
  it('puts the problem first on /games and filters by server', () => {
    const a = game({ name: 'survival', serverId: 'srv-a' });
    const b = game({
      name: 'valheim',
      status: 'crit',
      statusText: 'Container abgestürzt',
      serverId: 'srv-b',
    });
    const m = pageMeta('/games', { games: [a, b], servers: [] });
    expect(m.title).toEqual({ em: 'valheim: Container abgestürzt', rest: ' · 2 Gameserver' });
    expect(m.serverSwitch).toBe(true);
    expect(m.sub).toContain('1 laufen · 4 Spieler online');
    const s = server({ id: 'srv-a' });
    expect(pageMeta('/games', { games: [a, b], servers: [s], filter: 'srv-a' }).title.rest).toBe(
      'Gameserver läuft · 4 Spieler online',
    );
    expect(pageMeta('/games', {}).sub).toBe('lädt …');
  });

  it('describes one game and the create page', () => {
    const g = game({ id: 'game-abcdef01' });
    const m = pageMeta('/games/game-abcdef01', { games: [g] });
    expect(m.title.rest).toBe('survival läuft · 4 von 20 Spielern online');
    expect(m.sub).toBe('Gameserver · Minecraft Paper 1.21.4 · oracle-a1');
    expect(pageMeta('/games/new', {}).title.rest).toBe('Neuer Gameserver');
    expect(gameDetailId('/games/new')).toBeNull();
    expect(needsGames('/games/game-abcdef01')).toBe(true);
    expect(needsGames('/github')).toBe(false);
  });
});
