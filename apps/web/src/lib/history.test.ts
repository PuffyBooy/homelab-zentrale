import { describe, expect, it } from 'vitest';
import { bucket } from './history.js';

describe('bucket', () => {
  it('keeps short series', () => {
    expect(bucket([1, 2, 3], 48)).toEqual([1, 2, 3]);
  });

  it('averages equal slices', () => {
    expect(bucket([1, 3, 5, 7], 2)).toEqual([2, 6]);
    expect(
      bucket(
        Array.from({ length: 1440 }, (_, i) => i),
        48,
      ),
    ).toHaveLength(48);
  });
});
