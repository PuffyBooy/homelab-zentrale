import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Dispatcher } from './actions/index.js';
import { ContainerCollector, openDocker } from './collect/docker.js';
import { DockerEventWatcher } from './collect/docker-events.js';
import { hiddenDuringUpdate } from './actions/container-update.js';
import { collectInventory } from './collect/inventory.js';
import { SystemCollector } from './collect/system.js';
import { ConfigError, loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { debounce } from './debounce.js';
import { makeHostExec, runFile } from './exec.js';
import { normalizeArch, type HostContext } from './host.js';
import { createLogger } from './log.js';
import { StreamManager } from './streams.js';

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
  const containers = new ContainerCollector(docker, { hide: (id) => hiddenDuringUpdate.has(id) });
  const timers = new Set<NodeJS.Timeout>();
  const streams = new StreamManager({
    send: (msg) => conn.send(msg),
    bufferedAmount: () => conn.bufferedAmount(),
  });
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
      streams,
      run: runFile,
      dockerSocket: config.dockerSocket,
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
    collectInventory: () => collectInventory(host, system, containers),
    handleRpc: (env) => dispatcher.handle(env),
    onRpcResultSent: (result, sent) => dispatcher.resultSent(result, sent),
    onStreamCancel: (id) => streams.cancel(id),
    onDisconnect: () => streams.cancelAll(),
  });

  // Docker events: report state changes at once and push a fresh inventory
  // (debounced, so a burst of events costs one inventory).
  const inventorySoon = debounce(() => conn.requestInventory(), 1000, 5000);
  const events = docker
    ? new DockerEventWatcher(docker, {
        log,
        onEvent: (event) => {
          if ('dockerId' in event && hiddenDuringUpdate.has(event.dockerId)) return;
          conn.send({ type: 'event', ts: new Date().toISOString(), event });
        },
        onChange: (id) => {
          containers.invalidate(id ?? undefined);
          inventorySoon.trigger();
        },
      })
    : null;

  log.info('agent starting', {
    name: config.name,
    hostExec: config.hostExec,
    docker: docker !== null,
    terminal: config.allowTerminal,
  });
  await conn.start();
  events?.start();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    events?.stop();
    inventorySoon.cancel();
    streams.cancelAll();
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
