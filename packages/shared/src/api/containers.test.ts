import { describe, expect, it } from 'vitest';
import {
  containerActionParamsSchema,
  containerListQuerySchema,
  logLineSchema,
} from './containers.js';

describe('container API schemas', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv';

  it('accepts the four actions and nothing else', () => {
    for (const action of ['start', 'stop', 'restart', 'update']) {
      expect(containerActionParamsSchema.safeParse({ id, action }).success).toBe(true);
    }
    for (const action of ['delete', 'exec', 'logs', 'START', '']) {
      expect(containerActionParamsSchema.safeParse({ id, action }).success).toBe(false);
    }
  });

  it('rejects malformed ids and unknown keys', () => {
    for (const bad of ['short', 'a'.repeat(65), '../../etc/x', 'abc def ghi', 'abc/defghij']) {
      expect(containerActionParamsSchema.safeParse({ id: bad, action: 'start' }).success).toBe(
        false,
      );
    }
    expect(containerActionParamsSchema.safeParse({ id, action: 'start', x: 1 }).success).toBe(
      false,
    );
    expect(containerListQuerySchema.safeParse({ serverId: 'x', y: '1' }).success).toBe(false);
    expect(containerListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('log lines have a non-negative seq and a bounded text', () => {
    expect(logLineSchema.safeParse({ seq: 0, stream: 'stdout', text: 'hi' }).success).toBe(true);
    expect(logLineSchema.safeParse({ seq: -1, stream: 'stdout', text: '' }).success).toBe(false);
    expect(
      logLineSchema.safeParse({ seq: 1, stream: 'stdout', text: 'x'.repeat(16 * 1024 + 1) })
        .success,
    ).toBe(false);
  });
});
