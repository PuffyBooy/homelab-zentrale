import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Dispatcher } from './actions/index.js';
import { openDocker } from './collect/docker.js';
import { collectInventory } from './collect/inventory.js';
import { SystemCollector } from './collect/system.js';
import { ConfigError, loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { makeHostExec } from './exec.js';
import { normalizeArch, type HostContext } from './host.js';
import { createLogger } from './log.js';

async function agentVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  log.addSecret(config.token);

  const docker = await openDocker(config.dockerSocket);
  const host: HostContext = {
    hostProc: config.hostProc,
    hostRoot: config.hostRoot,
    exec: makeHostExec(config.hostExec),
    docker,
  };
  const system = new SystemCollector(host);
  const timers = new Set<NodeJS.Timeout>();
  const dispatcher = new Dispatcher(
    {
      name: config.name,
      allowTerminal: config.allowTerminal,
      homelabRoot: config.homelabRoot,
      host,
      log,
      later: (fn, ms) => {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
      },
    },
    (event) => conn.send(event),
  );

  const conn: AgentConnection = new AgentConnection({
    coreUrl: config.coreUrl,
    name: config.name,
    dataDir: config.dataDir,
    envToken: config.token,
    allowTerminal: config.allowTerminal,
    docker: docker !== null,
    version: await agentVersion(),
    arch: normalizeArch(os.arch()),
    osName: () => system.osName(),
    log,
    collectMetrics: () => system.metrics(),
    collectInventory: () => collectInventory(host, system),
    handleRpc: (env) => dispatcher.handle(env),
  });

  log.info('agent starting', {
    name: config.name,
    hostExec: config.hostExec,
    docker: docker !== null,
    terminal: config.allowTerminal,
  });
  await conn.start();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    conn.stop();
    for (const t of timers) clearTimeout(t);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Only the message: never dump objects that could carry the token.
  console.error('agent failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
