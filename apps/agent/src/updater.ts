import Docker from 'dockerode';
import { createLogger } from './log.js';
import { swapAgent, helperEnvSchema } from './update/agent-swap.js';
import type { ReplaceDocker } from './update/replace.js';

/**
 * Entry point of the M17 updater helper container (`node dist/updater.js`).
 * Started by the agent from its own (old) image with label hz.role=updater, the
 * Docker socket and /data only (src/update/helper.ts). Exits 0 when the run is
 * finished; the agent removes the exited helper container afterwards.
 */
async function main(): Promise<number> {
  const log = createLogger('info');
  const env = helperEnvSchema.safeParse(process.env);
  if (!env.success) {
    log.error('updater: invalid environment', {
      keys: env.error.issues.map((i) => i.path.join('.')).slice(0, 5),
    });
    return 2;
  }
  const docker = new Docker({ socketPath: '/var/run/docker.sock', timeout: 120_000 });
  const result = await swapAgent(docker as unknown as ReplaceDocker, env.data, { log });
  if (result) log.info('updater: done', { outcome: result.outcome, message: result.message });
  // 0 for every finished run (also rollbacks): non-zero means "crashed" and makes Docker
  // restart the helper (on-failure), which then resumes from the journal.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('updater failed:', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  });
