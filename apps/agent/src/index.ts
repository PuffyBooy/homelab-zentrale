import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { Dispatcher } from './actions/index.js';
import { ContainerCollector, openDocker } from './collect/docker.js';
import { DockerEventWatcher } from './collect/docker-events.js';
import { hiddenDuringUpdate } from './actions/container-update.js';
import { cleanupPartialBackups } from './actions/game-backup.js';
import { cleanupStaleTransfers } from './actions/game-transfer.js';
import { WakeManager } from './actions/game-wake.js';
import { collectInventory } from './collect/inventory.js';
import { SystemCollector } from './collect/system.js';
import { ConfigError, loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { debounce } from './debounce.js';
import { makeHostExec, runFile, spawnFile } from './exec.js';
import { normalizeArch, type HostContext } from './host.js';
import { createLogger } from './log.js';
import { PtyManager } from './actions/pty.js';
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
    sendTransfer: (msg) => conn.send(msg),
    bufferedAmount: () => conn.bufferedAmount(),
  });
  // Only constructed with HZ_AGENT_ALLOW_TERMINAL=1; node-pty loads on the first pty.open.
  const pty = config.allowTerminal
    ? new PtyManager({
        allowTerminal: true,
        hostExec: config.hostExec,
        host,
        streams,
        log,
      })
    : undefined;
  // Wake listeners of sleeping games (game.wake.arm); the event goes out on the
  // agent connection like every other event.
  const wake = new WakeManager({
    log,
    emit: (event) => {
      if (!conn.send({ type: 'event', ts: new Date().toISOString(), event })) {
        log.warn('game_wake event not sent (offline); the core re-arms on reconnect', {
          game: event.gameId,
        });
      }
    },
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
      spawn: spawnFile,
      dataDir: config.dataDir,
      ...(pty ? { pty } : {}),
      wake,
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
    onTransfer: (msg) => {
      if (!streams.deliver(msg)) log.debug('transfer frame for unknown stream dropped');
    },
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
  // Temp archives of backups that died with a previous agent process (no backup runs yet).
  const stale = await cleanupPartialBackups(config.homelabRoot);
  if (stale.length > 0) log.info('removed stale backup temp files', { count: stale.length });
  // Export temp archives and import staging folders of transfers that died with it.
  const staleTransfers = await cleanupStaleTransfers(config.homelabRoot);
  if (staleTransfers.length > 0) {
    log.info('removed stale transfer temp files', { count: staleTransfers.length });
  }

  await conn.start();
  events?.start();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    events?.stop();
    inventorySoon.cancel();
    streams.cancelAll();
    pty?.closeAll();
    conn.stop();
    for (const t of timers) clearTimeout(t);
    // Free the game ports before exiting (bounded: exit closes them anyway).
    const exit = setTimeout(() => process.exit(0), 1000);
    void wake.closeAll().finally(() => {
      clearTimeout(exit);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Only the message: never dump objects that could carry the token.
  console.error('agent failed:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
