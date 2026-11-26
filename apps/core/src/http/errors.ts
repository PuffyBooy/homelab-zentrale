import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ErrorCode, ErrorResponse, InsufficientRamDetails } from '@hz/shared';

/** Thrown by route handlers for expected failures. Carries only a stable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    public readonly retryAfter?: number,
    /** Fixed German hint for the user; never input values or internals. */
    public readonly userMessage?: string,
    /** Only with `insufficient_ram` (admin API; share links never get details). */
    public readonly details?: InsufficientRamDetails,
    /** Only with `price_changed` (M22): the current running price per hour. */
    public readonly currentEurPerHour?: number,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  retryAfter?: number,
  message?: string,
  details?: InsufficientRamDetails,
  currentEurPerHour?: number,
): FastifyReply {
  const body: ErrorResponse = { ok: false, error: code };
  if (retryAfter !== undefined) {
    body.retryAfter = retryAfter;
    void reply.header('retry-after', String(retryAfter));
  }
  if (message !== undefined) body.message = message;
  if (details !== undefined) body.details = details;
  if (currentEurPerHour !== undefined) body.currentEurPerHour = currentEurPerHour;
  return reply.code(status).send(body);
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'invalid_input';
  }
}

/**
 * Error responses never echo input or internals: zod/parser errors become
 * `400 invalid_input`, unknown errors `500 internal`. Client errors are logged
 * without their message (JSON parse messages can contain fragments of the body).
 */
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (err instanceof HttpError) {
    return sendError(
      reply,
      err.status,
      err.code,
      err.retryAfter,
      err.userMessage,
      err.details,
      err.currentEurPerHour,
    );
  }
  if (err instanceof z.ZodError) {
    request.log.debug({ issues: err.issues.length }, 'invalid input');
    return sendError(reply, 400, 'invalid_input');
  }
  const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 400 && status < 500) {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
    request.log.debug({ code, status }, 'client error');
    return sendError(reply, status, codeForStatus(status));
  }
  request.log.error({ err: { name: err.name, stack: err.stack } }, 'internal error');
  return sendError(reply, 500, 'internal');
}
