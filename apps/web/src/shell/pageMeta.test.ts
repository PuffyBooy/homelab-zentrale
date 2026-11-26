import { describe, expect, it } from 'vitest';
import { alert, check, container, server } from '../test-fixtures.js';
import {
  checkDetailId,
  containerLogsId,
  needsChecks,
  needsContainers,
  pageMeta,
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
      em: 'lernen.hoebe.at ist offline',
      rest: ' · 1 von 2 Checks erreichbar',
    });
    expect(meta.sub).toBe('Websites · 2 Checks · live');
    expect(meta.serverSwitch).toBe(true);
    const one = pageMeta('/websites', {
      servers: [home],
      checks: [down, check()],
      filter: home.id,
    });
    expect(one.title.em).toBe('lernen.hoebe.at ist offline');
    expect(one.title.rest).toBe(' · 0 von 1 Check erreichbar');
  });

  it('describes one check on its detail page', () => {
    const path = `/websites/${down.id}`;
    expect(checkDetailId(path)).toBe(down.id);
    expect(needsChecks(path)).toBe(true);
    const meta = pageMeta(path, { servers: [home], checks: [down] });
    expect(meta.title).toEqual({ em: 'lernen.hoebe.at ist offline', rest: ' · HTTP 503' });
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
