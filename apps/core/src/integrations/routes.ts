import type { FastifyPluginAsync } from 'fastify';
import {
  dnsFilterBlockingRequestSchema,
  dnsFilterStatusSchema,
  fritzRebootRequestSchema,
  fritzStatusSchema,
  INTEGRATIONS,
  integrationSettingsRequestSchema,
  integrationSettingsSchema,
  integrationUpdateNeedsStepUp,
  kumaImportRequestSchema,
  kumaImportResponseSchema,
  kumaMonitorsResponseSchema,
  okResponseSchema,
  proxmoxGuestActionParamsSchema,
  proxmoxGuestActionRequestSchema,
  proxmoxGuestActionResponseSchema,
  proxmoxGuestsResponseSchema,
  proxmoxTokenIdSchema,
  type IntegrationId,
  type IntegrationSettingsRequest,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { Integrations } from './index.js';
import { ProxmoxService } from './proxmox.js';

export interface IntegrationRoutesOptions {
  db: Db;
  now: Clock;
  integrations: Integrations;
}

/** Rules per integration that the shared request schema cannot know. */
function checkSettingsBody(id: IntegrationId, body: IntegrationSettingsRequest): void {
  if (body.variant !== undefined && id !== 'dnsfilter') {
    throw new HttpError(400, 'invalid_input', undefined, 'Variante gibt es nur beim DNS-Filter');
  }
  if (
    id === 'proxmox' &&
    body.username !== undefined &&
    body.username !== null &&
    !proxmoxTokenIdSchema.safeParse(body.username).success
  ) {
    throw new HttpError(400, 'invalid_input', undefined, 'Format: benutzer@realm!tokenname');
  }
}

/**
 * /api/proxmox, /api/dnsfilter, /api/fritzbox, /api/uptimekuma (SPEC 16).
 * Admin session everywhere (global guard), module gate before (404
 * module_disabled). Step-up: changing credentials/URL/CA/variant, deleting the
 * settings, Proxmox shutdown/stop/reboot, FRITZ!Box reboot. Every response goes
 * through the shared schema, so no secret can slip out.
 */
export const integrationRoutes: FastifyPluginAsync<IntegrationRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  for (const id of INTEGRATIONS) {
    const svc = o.integrations.get(id);

    app.get(`/${id}/settings`, async () => integrationSettingsSchema.parse(svc.settings()));

    app.put(`/${id}/settings`, async (request) => {
      const body = integrationSettingsRequestSchema.parse(request.body);
      checkSettingsBody(id, body);
      if (integrationUpdateNeedsStepUp(body) && !hasStepUp(request, o.now)) {
        throw new HttpError(403, 'step_up_required');
      }
      const r = await svc.updateSettings(body);
      // Only what changed, never a value.
      audit(`${id}.settings`, null, { ...r });
      return integrationSettingsSchema.parse(svc.settings());
    });

    app.delete(`/${id}/settings`, { preHandler: stepUp }, async () => {
      svc.clear();
      audit(`${id}.settings_cleared`, null);
      return okResponseSchema.parse({ ok: true });
    });

    app.post(`/${id}/test`, async () => integrationSettingsSchema.parse(await svc.test()));
  }

  // ---- Proxmox ------------------------------------------------------------------------

  const pve = o.integrations.proxmox;
  app.get('/proxmox/guests', async () => proxmoxGuestsResponseSchema.parse(await pve.guests()));

  app.post('/proxmox/guests/:node/:type/:vmid/:action', async (request) => {
    const params = proxmoxGuestActionParamsSchema.parse(request.params);
    const body = proxmoxGuestActionRequestSchema.parse(request.body ?? {});
    if (ProxmoxService.needsStepUp(params.action)) {
      // Step-up first: a stolen session must not take a running guest down.
      if (!hasStepUp(request, o.now)) throw new HttpError(403, 'step_up_required');
      if (body.confirm !== true) {
        throw new HttpError(400, 'invalid_input', undefined, 'Bestätigung fehlt');
      }
    }
    const r = await pve.action(params);
    audit('proxmox.guest_action', `${params.node}/${params.type}/${params.vmid}`, {
      action: params.action,
      name: r.guest.name,
      task: r.task,
    });
    return proxmoxGuestActionResponseSchema.parse({ ok: true, task: r.task });
  });

  // ---- DNS filter ---------------------------------------------------------------------

  const dns = o.integrations.dnsfilter;
  app.get('/dnsfilter/status', async () => dnsFilterStatusSchema.parse(await dns.filterStatus()));

  app.post('/dnsfilter/blocking', async (request) => {
    const body = dnsFilterBlockingRequestSchema.parse(request.body);
    const status = await dns.setBlocking(body);
    audit(
      'dnsfilter.blocking',
      null,
      body.enabled ? { enabled: true } : { enabled: false, minutes: body.minutes },
    );
    return dnsFilterStatusSchema.parse(status);
  });

  // ---- FRITZ!Box ----------------------------------------------------------------------

  const fritz = o.integrations.fritzbox;
  app.get('/fritzbox/status', async () => fritzStatusSchema.parse(await fritz.fritzStatus()));

  app.post('/fritzbox/reboot', { preHandler: stepUp }, async (request) => {
    fritzRebootRequestSchema.parse(request.body);
    await fritz.reboot();
    audit('fritzbox.reboot', null);
    return okResponseSchema.parse({ ok: true });
  });

  // ---- Uptime Kuma --------------------------------------------------------------------

  const kuma = o.integrations.uptimekuma;
  app.get('/uptimekuma/monitors', async () =>
    kumaMonitorsResponseSchema.parse(await kuma.monitors()),
  );

  app.post('/uptimekuma/import', async (request) => {
    const body = kumaImportRequestSchema.parse(request.body);
    const r = await kuma.importMonitors(body);
    for (const c of r.createdIds) {
      audit('check.created', c.id, { kind: c.def.kind, name: c.def.name, runFrom: c.def.runFrom });
    }
    audit('uptimekuma.import', null, { created: r.created, skipped: r.skipped.length });
    return kumaImportResponseSchema.parse({ created: r.created, skipped: r.skipped });
  });
};
