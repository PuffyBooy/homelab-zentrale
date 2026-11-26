import { describe, expect, it } from 'vitest';
import { container, server } from '../test-fixtures.js';
import { containerLogsId, needsContainers, pageMeta } from './pageMeta.js';

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
