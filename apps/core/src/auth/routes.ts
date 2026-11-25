import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  authStateSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  okResponseSchema,
  recoveryCodesResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  setupConfirmRequestSchema,
  setupStartRequestSchema,
  setupStartResponseSchema,
  STEP_UP_MINUTES,
  stepUpRequestSchema,
  stepUpResponseSchema,
  type AuthState,
} from '@hz/shared';
import { HttpError } from '../http/errors.js';
import { clearSessionCookie, requireStepUp, setSessionCookie } from './guard.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import type { FailureLimiter } from './rate-limit.js';
import { isTotpCode } from './recovery.js';
import type { AuthService } from './service.js';
import type { AuthContext } from './sessions.js';
import { newTotpSecret, totpQrSvg, totpUri, verifyTotp } from './totp.js';

export interface AuthRoutesOptions {
  auth: AuthService;
}

const STEP_UP_MS = STEP_UP_MINUTES * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function enforceLimit(limiter: FailureLimiter, ip: string): void {
  const r = limiter.check(ip);
  if (r.blocked) throw new HttpError(429, 'rate_limited', r.retryAfter);
}

function requireAuth(request: FastifyRequest): AuthContext {
  // The global guard already answered 401; this only narrows the type.
  if (!request.auth) throw new HttpError(401, 'unauthorized');
  return request.auth;
}

function stateFor(svc: AuthService, auth: AuthContext | null): AuthState {
  const state: AuthState = { setupRequired: !svc.hasUser(), authenticated: auth !== null };
  if (auth) {
    state.username = auth.user.username;
    const until = auth.session.stepUpUntil;
    if (until !== null && until > svc.now()) state.stepUpUntil = iso(until);
  }
  return authStateSchema.parse(state);
}

function startSession(
  svc: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: number,
): AuthContext {
  svc.sessions.pruneExpired();
  const { token } = svc.sessions.create(userId, request.headers['user-agent']);
  setSessionCookie(reply, token);
  const auth = svc.sessions.resolve(token);
  if (!auth) throw new Error('session vanished');
  return auth;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { auth: svc }) => {
  const stepUp = requireStepUp(svc.now);

  // ---- public ---------------------------------------------------------------

  app.get('/auth/state', async (request) => stateFor(svc, request.auth));

  app.post('/setup/start', async (request) => {
    enforceLimit(svc.setupLimiter, request.ip);
    const body = setupStartRequestSchema.parse(request.body);
    if (svc.hasUser()) throw new HttpError(409, 'setup_done');
    if (!svc.setup.checkToken(body.setupToken)) {
      svc.setupLimiter.fail(request.ip);
      svc.audit({ actor: 'anonymous', action: 'setup.failed', details: { ip: request.ip } });
      throw new HttpError(403, 'setup_invalid');
    }
    const secret = newTotpSecret();
    svc.setup.setPending({
      username: body.username,
      passwordHash: await hashPassword(body.password),
      totpSecret: secret,
    });
    const otpauthUri = totpUri(secret, body.username);
    return setupStartResponseSchema.parse({
      otpauthUri,
      secret,
      qrSvg: await totpQrSvg(otpauthUri),
    });
  });

  app.post('/setup/confirm', async (request, reply) => {
    enforceLimit(svc.setupLimiter, request.ip);
    const body = setupConfirmRequestSchema.parse(request.body);
    if (svc.hasUser()) throw new HttpError(409, 'setup_done');
    if (!svc.setup.checkToken(body.setupToken)) {
      svc.setupLimiter.fail(request.ip);
      svc.audit({ actor: 'anonymous', action: 'setup.failed', details: { ip: request.ip } });
      throw new HttpError(403, 'setup_invalid');
    }
    const pending = svc.setup.getPending();
    if (!pending) throw new HttpError(400, 'setup_invalid');
    const step = verifyTotp(pending.totpSecret, body.code, svc.now(), null);
    if (step === null) {
      svc.setupLimiter.fail(request.ip);
      svc.audit({
        actor: 'anonymous',
        action: 'setup.failed',
        details: { ip: request.ip, reason: 'totp' },
      });
      throw new HttpError(403, 'invalid_credentials');
    }
    const { user, recoveryCodes } = svc.createAdmin({
      username: pending.username,
      passwordHash: pending.passwordHash,
      totpSecret: pending.totpSecret,
      totpStep: step,
    });
    svc.setup.finish();
    svc.setupLimiter.reset(request.ip);
    const auth = startSession(svc, request, reply, user.id);
    svc.audit({
      actor: 'admin',
      action: 'setup.complete',
      target: user.username,
      details: { ip: request.ip, session: auth.session.id },
    });
    return recoveryCodesResponseSchema.parse({ recoveryCodes });
  });

  app.post('/auth/login', async (request, reply) => {
    enforceLimit(svc.loginLimiter, request.ip);
    const body = loginRequestSchema.parse(request.body);
    // Count the attempt before the first await, so parallel requests cannot
    // slip past the limit while argon2 runs. A success resets it below.
    svc.loginLimiter.fail(request.ip);
    const user = svc.findUser(body.username);
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? (await dummyPasswordHash()),
      body.password,
    );
    let method: 'totp' | 'recovery' | null = null;
    if (user && passwordOk) {
      if (isTotpCode(body.code)) {
        if (svc.consumeTotp(user, body.code)) method = 'totp';
      } else if (svc.consumeRecoveryCode(user, body.code)) {
        method = 'recovery';
      }
    }
    if (!user || method === null) {
      svc.audit({
        actor: 'anonymous',
        action: 'auth.login_failed',
        target: body.username,
        details: { ip: request.ip, reason: !user || !passwordOk ? 'password' : 'second_factor' },
      });
      throw new HttpError(401, 'invalid_credentials');
    }
    svc.loginLimiter.reset(request.ip);
    const auth = startSession(svc, request, reply, user.id);
    const details: Record<string, unknown> = {
      ip: request.ip,
      method,
      session: auth.session.id,
    };
    if (method === 'recovery') details.recoveryCodesLeft = svc.remainingRecoveryCodes(user.id);
    svc.audit({ actor: 'admin', action: 'auth.login', target: user.username, details });
    return stateFor(svc, auth);
  });

  // ---- session required (global guard) --------------------------------------

  app.post('/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    svc.sessions.revoke(auth.user.id, auth.session.id);
    clearSessionCookie(reply);
    svc.audit({ actor: 'admin', action: 'auth.logout', target: auth.session.id });
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/auth/step-up', async (request) => {
    const auth = requireAuth(request);
    enforceLimit(svc.stepUpLimiter, request.ip);
    const body = stepUpRequestSchema.parse(request.body);
    if (!svc.consumeTotp(auth.user, body.code)) {
      svc.stepUpLimiter.fail(request.ip);
      svc.audit({
        actor: 'admin',
        action: 'auth.step_up_failed',
        target: auth.session.id,
        details: { ip: request.ip },
      });
      throw new HttpError(403, 'invalid_credentials');
    }
    svc.stepUpLimiter.reset(request.ip);
    const until = svc.now() + STEP_UP_MS;
    svc.sessions.setStepUp(auth.session.id, until);
    svc.audit({ actor: 'admin', action: 'auth.step_up', target: auth.session.id });
    return stepUpResponseSchema.parse({ stepUpUntil: iso(until) });
  });

  app.post('/auth/recovery-codes', { preHandler: stepUp }, async (request) => {
    const auth = requireAuth(request);
    const recoveryCodes = svc.replaceRecoveryCodes(auth.user.id);
    svc.audit({
      actor: 'admin',
      action: 'auth.recovery_codes_regenerated',
      target: auth.user.username,
    });
    return recoveryCodesResponseSchema.parse({ recoveryCodes });
  });

  app.post('/auth/password', { preHandler: stepUp }, async (request) => {
    const auth = requireAuth(request);
    enforceLimit(svc.stepUpLimiter, request.ip);
    const body = changePasswordRequestSchema.parse(request.body);
    svc.stepUpLimiter.fail(request.ip);
    if (!(await verifyPassword(auth.user.passwordHash, body.currentPassword))) {
      svc.audit({
        actor: 'admin',
        action: 'auth.password_change_failed',
        target: auth.user.username,
        details: { ip: request.ip },
      });
      throw new HttpError(403, 'invalid_credentials');
    }
    svc.stepUpLimiter.reset(request.ip);
    svc.setPassword(auth.user.id, await hashPassword(body.newPassword));
    const revoked = svc.sessions.revokeOthers(auth.user.id, auth.session.id);
    svc.audit({
      actor: 'admin',
      action: 'auth.password_changed',
      target: auth.user.username,
      details: { revokedSessions: revoked },
    });
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/auth/sessions', async (request) => {
    const auth = requireAuth(request);
    return sessionListResponseSchema.parse({
      sessions: svc.sessions.list(auth.user.id).map((s) => ({
        id: s.id,
        current: s.id === auth.session.id,
        userAgent: s.userAgent,
        createdAt: iso(s.createdAt),
        lastSeen: iso(s.lastSeen),
        expiresAt: iso(s.expiresAt),
      })),
    });
  });

  app.delete('/auth/sessions/:id', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = sessionIdParamsSchema.parse(request.params);
    if (!svc.sessions.revoke(auth.user.id, id)) throw new HttpError(404, 'not_found');
    if (id === auth.session.id) clearSessionCookie(reply);
    svc.audit({ actor: 'admin', action: 'auth.session_revoked', target: id });
    return okResponseSchema.parse({ ok: true });
  });
};
