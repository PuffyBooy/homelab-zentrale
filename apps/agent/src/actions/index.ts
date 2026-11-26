import {
  parseRpc,
  streamingActions,
  terminalActions,
  type AgentEvent,
  type RpcAction,
  type RpcEnvelope,
  type RpcErrorCode,
  type RpcRequest,
  type RpcResult,
} from '@hz/shared';
import { resolveHomelabPath } from '../paths.js';
import { checkHttp, checkPing, checkTcp } from './checks.js';
import { composeDown, composePull, composeUp, composeWrite } from './compose.js';
import { containerRestart, containerStart, containerStop } from './container.js';
import { containerLimit } from './container-limit.js';
import { containerUpdate } from './container-update.js';
import { containerLogs } from './logs.js';
import { logsSearch } from './logs-search.js';
import { imageScan } from './image-scan.js';
import { fail2banStatus, fail2banUnban } from './fail2ban.js';
import { backupTargetStatus, backupTargetStore, backupTargetSync } from './backup-target.js';
import { deployRun } from './deploy.js';
import { deployKey } from './deploy-key.js';
import { gameBackup } from './game-backup.js';
import { gameBackupsPurge } from './game-backups-purge.js';
import { gameExport } from './game-export.js';
import { gameImport } from './game-import.js';
import { gameModsInstall, gameModsList, gameModsRemove } from './game-mods.js';
import { gameRestore } from './game-restore.js';
import { gameWakeArm, gameWakeDisarm } from './game-wake.js';
import { gameRemove } from './game-remove.js';
import { gameRcon, gameStatus } from './games.js';
import { relaySet } from './relay.js';
import { ptyClose, ptyInput, ptyOpen, ptyResize } from './pty.js';
import { cleanup, cleanupPreview } from './system-cleanup.js';
import { systemReboot } from './system-reboot.js';
import { wolSend } from './wol-send.js';
import {
  ActionError,
  type ActionContext,
  type ActionHandler,
  type ActionHandlers,
} from './types.js';

export { ActionError } from './types.js';
export type { ActionContext } from './types.js';

/** One handler per allowlisted action. */
export const handlers: ActionHandlers = {
  'container.start': containerStart,
  'container.stop': containerStop,
  'container.restart': containerRestart,
  'container.update': containerUpdate,
  'container.logs': containerLogs,
  'container.limit': containerLimit,
  'compose.up': composeUp,
  'compose.down': composeDown,
  'compose.pull': composePull,
  'compose.write': composeWrite,
  'game.rcon': gameRcon,
  'game.backup': (p, ctx, id) => gameBackup(p, ctx, id),
  'game.backups.purge': (p, ctx) => gameBackupsPurge(p, ctx),
  'game.status': gameStatus,
  'game.remove': gameRemove,
  'deploy.run': deployRun,
  'deploy.key': deployKey,
  'system.cleanupPreview': cleanupPreview,
  'system.cleanup': cleanup,
  'system.reboot': systemReboot,
  'wol.send': wolSend,
  'check.http': checkHttp,
  'check.tcp': checkTcp,
  'check.ping': checkPing,
  'pty.open': ptyOpen,
  'pty.input': ptyInput,
  'pty.resize': ptyResize,
  'pty.close': ptyClose,
  'game.export': (p, ctx, id) => gameExport(p, ctx, id),
  'game.import': (p, ctx, id) => gameImport(p, ctx, id),
  'game.wake.arm': gameWakeArm,
  'game.wake.disarm': gameWakeDisarm,
  'game.mods.list': gameModsList,
  'game.mods.install': gameModsInstall,
  'game.mods.remove': gameModsRemove,
  'game.restore': (p, ctx, id) => gameRestore(p, ctx, id),
  'relay.set': relaySet,
  'logs.search': (p, ctx) => logsSearch(p, ctx),
  'image.scan': (p, ctx) => imageScan(p, ctx),
  'fail2ban.status': (p, ctx) => fail2banStatus(p, ctx),
  'fail2ban.unban': (p, ctx) => fail2banUnban(p, ctx),
  'backup.target.status': (p, ctx) => backupTargetStatus(p, ctx),
  'backup.target.sync': (p, ctx) => backupTargetSync(p, ctx),
  'backup.target.store': (p, ctx, id) => backupTargetStore(p, ctx, id),
};

export function hasGitSegment(p: unknown): boolean {
  return typeof p === 'string' && p.split('/').some((seg) => seg.toLowerCase() === '.git');
}

/** Param fields that carry a file system path below /opt/homelab/. */
const PATH_FIELDS = ['dir', 'gameDir'] as const;

type DenyCode = Extract<
  RpcErrorCode,
  'not_allowed' | 'invalid_params' | 'bad_path' | 'terminal_disabled' | 'confirm_mismatch'
>;
const DENY_CODES = new Set<RpcErrorCode>([
  'not_allowed',
  'invalid_params',
  'bad_path',
  'terminal_disabled',
  'confirm_mismatch',
]);

export class Dispatcher {
  constructor(
    private readonly ctx: ActionContext,
    /** Sends an event (denied) to the core. */
    private readonly emit: (event: AgentEvent) => void,
    private readonly table: ActionHandlers = handlers,
  ) {}

  private fail(id: string, code: RpcErrorCode, message: string): RpcResult {
    return { type: 'rpc.result', id, ok: false, error: { code, message: message.slice(0, 500) } };
  }

  private deny(env: RpcEnvelope, code: DenyCode, message: string): RpcResult {
    const action = env.action.slice(0, 64);
    this.ctx.log.warn('rpc denied', { action, code, reason: message.slice(0, 200) });
    this.emit({
      type: 'event',
      ts: new Date().toISOString(),
      event: { kind: 'denied', action, reason: `${code}: ${message}`.slice(0, 200) },
    });
    return this.fail(env.id, code, message);
  }

  /**
   * Call after the rpc.result went out (or failed to). Streams go live only after
   * their result, so the core always sees rpc.result before stream.data.
   */
  resultSent(result: RpcResult, sent: boolean): void {
    if (!this.ctx.streams.has(result.id)) return;
    if (sent && result.ok) this.ctx.streams.activate(result.id);
    else this.ctx.streams.discard(result.id);
  }

  /** Validates (allowlist, params, terminal, paths) and runs one RPC. Never throws. */
  async handle(env: RpcEnvelope): Promise<RpcResult> {
    const parsed = parseRpc(env);
    if (!parsed.ok) return this.deny(env, parsed.code, parsed.message);
    const req = parsed.request;

    if (terminalActions.includes(req.action) && !this.ctx.allowTerminal) {
      return this.deny(env, 'terminal_disabled', 'terminal is disabled on this server');
    }

    const params = { ...(req.params as Record<string, unknown>) };
    for (const field of PATH_FIELDS) {
      if (!Object.hasOwn(params, field)) continue;
      // Never inside a git directory: .git/config and hooks would run code in git (deploy.run).
      const gitDenied = () => this.deny(env, 'bad_path', `${field}: path inside a .git directory`);
      if (hasGitSegment(params[field])) return gitDenied();
      const check = await resolveHomelabPath(params[field], this.ctx.homelabRoot);
      if (!check.ok) return this.deny(env, 'bad_path', `${field}: ${check.reason}`);
      if (hasGitSegment(check.path)) return gitDenied();
      params[field] = check.path;
    }

    const handler = this.table[req.action] as ActionHandler<RpcAction>;
    const streaming = streamingActions.includes(req.action);
    try {
      const data = await handler(params as RpcRequest['params'], this.ctx, req.id);
      return { type: 'rpc.result', id: req.id, ok: true, data: data ?? null };
    } catch (err) {
      // A failed streaming action never sends stream.data/stream.end.
      if (streaming) this.ctx.streams.discard(req.id);
      if (err instanceof ActionError) {
        if (err.audit && DENY_CODES.has(err.code))
          return this.deny(env, err.code as DenyCode, err.message);
        return this.fail(req.id, err.code, err.message);
      }
      this.ctx.log.error('rpc failed', { action: req.action, error: err });
      return this.fail(req.id, 'failed', 'action failed');
    }
  }
}
