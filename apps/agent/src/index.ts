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
import { SmartReader } from './collect/storage.js';
import { SystemCollector } from './collect/system.js';
import { ConfigError, loadConfig } from './config.js';
import { AgentConnection } from './connection.js';
import { debounce } from './debounce.js';
import { makeHostExec, runFile, spawnFile } from './exec.js';
import { normalizeArch, type HostContext } from './host.js';
import { createLogger } from './log.js';
import { PtyManager } from './actions/pty.js';
import { TaskManager } from './actions/task-exec.js';
import { RelayManager } from './actions/relay.js';
import { StreamManager } from './streams.js';
import { markConnected, markDisconnected } from './health.js';
import { UpdateService } from './update/service.js';
import type { ReplaceDocker } from './update/replace.js';

/** While connected, saved update results are looked for this often (the helper writes them late). */
const RESULT_FLUSH_MS = 15_000;

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
  if (config.ignoredServices.length > 0) {
    log.warn('HZ_AGENT_SERVICES: entries ignored (invalid or on the deny list)', {
      entries: config.ignoredServices,
    });
  }
  await markDisconnected();
  if (config.trivyImageRejected) {
    log.warn(
      'HZ_AGENT_TRIVY_IMAGE is not pinned by digest (repo[:tag]@sha256:...), using the default',
    );
  }

  const docker = await openDocker(config.dockerSocket);
  const host: HostContext = {
    hostProc: config.hostProc,
    hostRoot: config.hostRoot,
    exec: makeHostExec(config.hostExec),
    docker,
  };
  const system = new SystemCollector(host);
  const storageOpts = {
    smart: config.smart,
    ...(config.smart ? { smartReader: new SmartReader(config.hostRoot) } : {}),
  };
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
  // Only constructed with HZ_AGENT_ALLOW_TASKS=1 (task.exec).
  const tasks = config.allowTasks
    ? new TaskManager({
        allowTasks: true,
        hostExec: config.hostExec,
        host,
        homelabRoot: config.homelabRoot,
        log,
      })
    : undefined;
  // Wake listeners of sleeping games (game.wake.arm); the event goes out on the
  // agent connection like every other event.
  const wake: WakeManager = new WakeManager({
    log,
    // relay is created right below; the closure only runs on game.wake.arm.
    relayHolds: (port, protocol) => relay?.holds(port, protocol) ?? false,
    emit: (event) => {
      if (!conn.send({ type: 'event', ts: new Date().toISOString(), event })) {
        log.warn('game_wake event not sent (offline); the core re-arms on reconnect', {
          game: event.gameId,
        });
      }
    },
  });
  // M17 image updates (core and agent); results go out as events once connected.
  const updates = docker
    ? new UpdateService({
        docker: docker as unknown as ReplaceDocker,
        dataDir: config.dataDir,
        dockerSocket: config.dockerSocket,
        log,
        emit: (msg) => conn.send(msg),
      })
    : undefined;
  const flushUpdates = () => {
    if (!updates || !conn.isReady()) return;
    void updates
      .flush()
      .catch((err: unknown) => log.warn('update results not sent', { error: err }));
  };
  // A core swap that died with the previous agent process: finish or undo it now
  // (the core may be down, so this cannot wait for a connection).
  await updates
    ?.recoverAtStart()
    .catch((err: unknown) => log.error('update recovery failed', { error: err }));
  // Game relay ingress: only constructed with HZ_AGENT_ALLOW_RELAY=1; it never
  // takes a port of a wake listener.
  const relay: RelayManager | undefined = config.allowRelay
    ? new RelayManager({ log, wakeHolds: (port, protocol) => wake.holds(port, protocol) })
    : undefined;
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
      trivyImage: config.trivyImage,
      ...(pty ? { pty } : {}),
      allowTasks: config.allowTasks,
      ...(tasks ? { tasks } : {}),
      wake,
      services: config.services,
      ...(updates ? { updates } : {}),
      ...(relay ? { relay } : {}),
    },
    (event) => conn.send(event),
  );

  const conn: AgentConnection = new AgentConnection({
    coreUrl: config.coreUrl,
    name: config.name,
    dataDir: config.dataDir,
    envToken: config.token,
    allowTerminal: config.allowTerminal,
    allowTasks: config.allowTasks,
    allowRelay: config.allowRelay,
    docker: docker !== null,
    version: await agentVersion(),
    arch: normalizeArch(os.arch()),
    osName: () => system.osName(),
    log,
    collectMetrics: () => system.metrics(),
    collectInventory: () => collectInventory(host, system, containers, storageOpts),
    handleRpc: (env) => dispatcher.handle(env),
    onRpcResultSent: (result, sent) => dispatcher.resultSent(result, sent),
    onStreamCancel: (id) => streams.cancel(id),
    onTransfer: (msg) => {
      if (!streams.deliver(msg)) log.debug('transfer frame for unknown stream dropped');
    },
    onDisconnect: () => {
      streams.cancelAll();
      void markDisconnected();
    },
    onReady: () => {
      void markConnected();
      void updates
        ?.onReady()
        .catch((err: unknown) => log.warn('update results not sent', { error: err }));
    },
  });
  const flushTimer = setInterval(flushUpdates, RESULT_FLUSH_MS);
  flushTimer.unref();

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
    tasks: config.allowTasks,
    relay: config.allowRelay,
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
    tasks?.killAll();
    conn.stop();
    clearInterval(flushTimer);
    void markDisconnected();
    for (const t of timers) clearTimeout(t);
    // Free the game ports before exiting (bounded: exit closes them anyway).
    const exit = setTimeout(() => process.exit(0), 1000);
    void Promise.all([wake.closeAll(), relay?.closeAll()]).finally(() => {
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
