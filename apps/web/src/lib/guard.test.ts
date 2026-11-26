import { describe, expect, it } from 'vitest';
import { decideGuard, safeReturnPath } from './guard.js';

const setup = { setupRequired: true, authenticated: false };
const out = { setupRequired: false, authenticated: false };
const inn = { setupRequired: false, authenticated: true, username: 'admin' };

describe('decideGuard', () => {
  it('waits until the state is known', () => {
    expect(decideGuard(undefined, 'protected')).toEqual({ kind: 'wait' });
  });

  it('sends everything to /setup while setup is required', () => {
    expect(decideGuard(setup, 'protected')).toEqual({ kind: 'redirect', to: '/setup' });
    expect(decideGuard(setup, 'login')).toEqual({ kind: 'redirect', to: '/setup' });
    expect(decideGuard(setup, 'setup')).toEqual({ kind: 'render' });
  });

  it('sends guests to /login', () => {
    expect(decideGuard(out, 'protected')).toEqual({ kind: 'redirect', to: '/login' });
    expect(decideGuard(out, 'setup')).toEqual({ kind: 'redirect', to: '/login' });
    expect(decideGuard(out, 'login')).toEqual({ kind: 'render' });
  });

  it('lets the admin in and keeps him away from login and setup', () => {
    expect(decideGuard(inn, 'protected')).toEqual({ kind: 'render' });
    expect(decideGuard(inn, 'login')).toEqual({ kind: 'redirect', to: '/' });
    expect(decideGuard(inn, 'setup')).toEqual({ kind: 'redirect', to: '/' });
  });
});

describe('safeReturnPath', () => {
  it('only allows local paths', () => {
    expect(safeReturnPath('/servers')).toBe('/servers');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/login')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
  });
});
