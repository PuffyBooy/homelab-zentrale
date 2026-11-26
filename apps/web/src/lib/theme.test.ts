import { describe, expect, it } from 'vitest';
import { otherTheme, parseStoredTheme, resolveTheme } from './theme.js';

describe('theme', () => {
  it('follows the system when nothing is stored', () => {
    expect(resolveTheme(null, false)).toBe('dark');
    expect(resolveTheme(null, true)).toBe('light');
  });

  it('keeps an explicit choice', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('accepts only known stored values', () => {
    expect(parseStoredTheme('light')).toBe('light');
    expect(parseStoredTheme('wall')).toBeNull();
    expect(parseStoredTheme(null)).toBeNull();
    expect(parseStoredTheme('<script>')).toBeNull();
  });

  it('toggles between dark and light', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });
});
