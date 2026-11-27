import { describe, expect, it } from 'vitest';
import { rpc } from './admin-helpers.js';
import { AGENT_ID, APP_ID, newState, setupDocker, at } from './docker-fakes.js';

describe('container.remove', () => {
  it('removes a stopped container without force, with v as requested', async () => {
    const st = newState();
    const { d } = setupDocker(st);
    const r = await d.handle(rpc('container.remove', { id: APP_ID, removeVolumes: true }));
    expect(r).toMatchObject({ ok: true, data: null });
    expect(st.removeOpts).toEqual([{ v: true, force: false }]);
    await d.handle(rpc('container.remove', { id: APP_ID }));
    expect(st.removeOpts[1]).toEqual({ v: false, force: false });
  });

  it('refuses the agent container (protected) without calling remove', async () => {
    const st = newState();
    const { d, events } = setupDocker(st);
    const r = await d.handle(rpc('container.remove', { id: AGENT_ID, removeVolumes: false }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(st.calls.some((c) => c.startsWith('rm '))).toBe(false);
    expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
  });

  it.each(['running', 'restarting', 'paused'])(
    'a %s container is busy, never forced',
    async (state) => {
      const st = newState();
      at(st.containers, 1).State = state;
      const { d } = setupDocker(st);
      const r = await d.handle(rpc('container.remove', { id: APP_ID }));
      expect(r).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(st.removeOpts).toEqual([]);
    },
  );

  it('maps 404 to not_found, 409 to busy, other errors to failed without docker text', async () => {
    const missing = await setupDocker(newState()).d.handle(rpc('container.remove', { id: 'nope' }));
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
    for (const [status, code] of [
      [409, 'busy'],
      [500, 'failed'],
    ] as const) {
      const st = newState({ removeError: status });
      const r = await setupDocker(st).d.handle(rpc('container.remove', { id: APP_ID }));
      expect(r).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(r)).not.toContain('hunter2');
    }
  });

  it('rejects a ref that is not a container ref', async () => {
    const st = newState();
    const r = await setupDocker(st).d.handle(rpc('container.remove', { id: '--force' }));
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(st.calls).toEqual([]);
  });
});
