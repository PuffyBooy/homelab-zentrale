import { describe, expect, it } from 'vitest';
import { navItems } from '../nav.js';
import { pageCommands } from '../shell/CommandPalette.js';
import { pageMeta } from '../shell/pageMeta.js';
import {
  anyModuleOn,
  isModuleOn,
  moduleOfPath,
  modulesLabel,
  modulesOfPath,
  visibleNavItems,
} from './modules.js';

const off = {
  github: false,
  homeassistant: false,
  games: false,
  storage: false,
  tasks: false,
  selfheal: false,
  speedtest: false,
  domains: false,
  apps: false,
};

describe('modules', () => {
  it('maps paths to their module', () => {
    expect(moduleOfPath('/github')).toBe('github');
    expect(moduleOfPath('/github/abcdefgh')).toBe('github');
    expect(moduleOfPath('/home')).toBe('homeassistant');
    expect(moduleOfPath('/games/new')).toBe('games');
    expect(moduleOfPath('/servers')).toBeUndefined();
    expect(moduleOfPath('/homeassistant')).toBeUndefined();
    expect(moduleOfPath('/apps')).toBe('apps');
    expect(modulesOfPath('/automation')).toEqual(['tasks', 'selfheal']);
    expect(modulesOfPath('/internet')).toEqual(['speedtest', 'domains']);
    expect(modulesOfPath('/constructor')).toBeUndefined();
  });

  it('keeps a page of several modules while any of them is on', () => {
    expect(anyModuleOn(off, ['tasks', 'selfheal'])).toBe(false);
    expect(anyModuleOn({ ...off, selfheal: true }, ['tasks', 'selfheal'])).toBe(true);
    const ids = (m: typeof off) => visibleNavItems(navItems, m).map((i) => i.id);
    expect(ids(off)).not.toContain('automation');
    expect(ids(off)).not.toContain('internet');
    expect(ids(off)).not.toContain('apps');
    expect(ids({ ...off, selfheal: true })).toContain('automation');
    expect(ids({ ...off, domains: true })).toContain('internet');
    expect(ids({ ...off, domains: true })).not.toContain('automation');
    expect(ids({ ...off, apps: true })).toContain('apps');
    expect(modulesLabel(['tasks', 'selfheal'])).toBe('Geplante Aufgaben und Selbstheilung');
  });

  it('treats unknown modules as on', () => {
    expect(isModuleOn(undefined, 'github')).toBe(true);
    expect(isModuleOn(off, 'github')).toBe(false);
  });

  it('hides nav items and palette pages of switched-off modules', () => {
    const ids = visibleNavItems(navItems, off).map((i) => i.id);
    expect(ids).not.toContain('github');
    expect(ids).not.toContain('home');
    expect(ids).not.toContain('games');
    const pages = pageCommands(off).map((c) => c.id);
    expect(pages).toEqual([...ids, 'settings']);
    expect(pageCommands().map((c) => c.id)).toContain('github');
  });

  it('gives the page of a switched-off module a fixed title', () => {
    const meta = pageMeta('/github', { modules: { ...off, games: true } });
    expect(meta.title.rest).toBe('GitHub ist ausgeschaltet.');
    expect(meta.serverSwitch).toBe(false);
    expect(pageMeta('/github', {}).title.rest).toBe('GitHub');
    expect(pageMeta('/automation', { modules: off }).title.rest).toBe(
      'Automatik: Module ausgeschaltet.',
    );
    expect(pageMeta('/internet', { modules: off }).sub).toBe(
      'Internet · Speedtest oder Domains und Zertifikate einschalten unter Einstellungen → Module',
    );
    expect(pageMeta('/apps', { modules: off }).title.rest).toBe('App-Store ist ausgeschaltet.');
  });
});
