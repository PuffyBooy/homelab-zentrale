import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { CheckResultData, RpcParams } from '@hz/shared';
import { runFile } from '../exec.js';
import { ActionError } from './types.js';

/**
 * check.tcp / check.http / check.ping, run from this agent ("von außen").
 * M2 keeps them simple: no redirects are followed, body read up to 1 MiB for
 * `contains`. M4 extends them.
 */

const MAX_BODY = 1024 * 1024;
const short = (s: string) => s.slice(0, 300);

function stripBrackets(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1');
}

function rejectOptionLike(host: string): void {
  // The schema allows '-' anywhere; a leading '-' could look like an option.
  if (host.startsWith('-')) throw new ActionError('invalid_params', 'invalid host');
}

export function checkTcp(p: RpcParams<'check.tcp'>): Promise<CheckResultData> {
  rejectOptionLike(p.host);
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: stripBrackets(p.host), port: p.port });
    const done = (r: CheckResultData) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(p.timeoutMs, () => done({ ok: false, ms: null, error: 'timeout' }));
    socket.once('connect', () => done({ ok: true, ms: Math.round(performance.now() - started) }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done({ ok: false, ms: null, error: short(err.code ?? 'connect failed') }),
    );
  });
}

export function checkHttp(p: RpcParams<'check.http'>): Promise<CheckResultData> {
  const url = new URL(p.url);
  const started = performance.now();
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CheckResultData) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = lib.request(
      url,
      { method: p.method, headers: { 'user-agent': 'homelab-agent-check', accept: '*/*' } },
      (res) => {
        const ms = Math.round(performance.now() - started);
        const code = res.statusCode ?? 0;
        const result: CheckResultData = {
          ok: code >= p.expectStatusMin && code <= p.expectStatusMax,
          code,
          ms,
        };
        const sock = res.socket as TLSSocket;
        if (typeof sock.getPeerCertificate === 'function') {
          const cert = sock.getPeerCertificate();
          const exp = cert?.valid_to ? new Date(cert.valid_to) : null;
          if (exp && !Number.isNaN(exp.getTime())) result.tlsExpiresAt = exp.toISOString();
        }
        if (p.contains === undefined || p.method === 'HEAD') {
          res.resume();
          finish(result);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length >= MAX_BODY) res.destroy();
        });
        const end = () => {
          if (p.contains !== undefined && !body.includes(p.contains)) {
            result.ok = false;
            result.error = 'text not found';
          }
          finish(result);
        };
        res.on('end', end);
        res.on('close', end);
      },
    );
    const timer = setTimeout(() => finish({ ok: false, ms: null, error: 'timeout' }), p.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) =>
      finish({ ok: false, ms: null, error: short(err.code ?? 'request failed') }),
    );
    req.end();
  });
}

/** "rtt min/avg/max/mdev = 0.031/0.042/0.051/0.008 ms" -> avg */
export function parsePingAvg(text: string): number | null {
  const m = /= [\d.]+\/([\d.]+)\//.exec(text);
  return m?.[1] ? Number(m[1]) : null;
}

export async function checkPing(p: RpcParams<'check.ping'>): Promise<CheckResultData> {
  rejectOptionLike(p.host);
  const deadlineS = Math.max(1, Math.ceil(p.timeoutMs / 1000));
  const r = await runFile(
    'ping',
    ['-n', '-q', '-c', String(p.count), '-w', String(deadlineS), '--', stripBrackets(p.host)],
    { timeoutMs: p.timeoutMs + 2000 },
  );
  if (r.error === 'not_found') throw new ActionError('failed', 'ping not available');
  const avg = parsePingAvg(r.stdout);
  if (r.code === 0 && avg !== null) return { ok: true, ms: Math.round(avg * 10) / 10 };
  return { ok: false, ms: null, error: r.error ?? 'no reply' };
}
