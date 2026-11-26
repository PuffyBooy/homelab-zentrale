import {
  AZURE_DISK_SIZES,
  AZURE_DISK_TYPES,
  AZURE_PUBLIC_IP_EUR_PER_HOUR,
  AZURE_REGION_LABELS,
  AZURE_REGIONS,
  CLOUD_IDLE_MINUTES_DEFAULT,
  CLOUD_MACHINE_STATE_TEXT,
  CLOUD_OS_RAM_GB,
  CLOUD_PRICE_TOLERANCE_EUR,
  HOURS_PER_MONTH,
  azureClientSecretSchema,
  azurePricesResponseSchema,
  azureResourceGroupSchema,
  azureSettingsSchema,
  cloudMachineNameSchema,
  cloudMachineResponseSchema,
  cloudOverviewSchema,
  recommendAzureSize,
  tailscaleAuthKeySchema,
  type AzureDiskType,
  type AzurePricesResponse,
  type AzureRegion,
  type AzureSettings,
  type AzureSettingsRequest,
  type CloudBudget,
  type CloudCost,
  type CloudMachine,
  type CloudMachineCreateRequest,
  type CloudMachineState,
  type CloudOverview,
  type CloudPendingGame,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { formatGrouped, formatNumber } from './format.js';
import { parseNumber as parseLocaleNumber, type GameCreateBody } from './games.js';

/** Cloud-Server (M22, module cloud). Routes from packages/shared/src/api/cloud.ts. */

export const cloudKey = ['cloud'] as const;
export const azureKey = ['cloud', 'azure'] as const;
export const azurePricesKey = (q: PriceQuery) =>
  ['cloud', 'azure', 'prices', q.region, q.diskType, q.diskGb, q.publicIp] as const;

/** Poll fast while a machine changes state, else slowly. */
export const CLOUD_FAST_MS = 5_000;
export const CLOUD_SLOW_MS = 30_000;

/** Query parameter of /cloud with the machine that was just ordered (highlighted). */
export const MACHINE_PARAM = 'maschine';

/** Value of the "Zielserver" select for "Neuer Azure-Server …" (never a server id). */
export const CLOUD_TARGET = 'cloud:azure';

const TRANSITIONAL: readonly CloudMachineState[] = [
  'creating',
  'installing',
  'stopping',
  'starting',
  'deleting',
];

export function isTransitional(state: CloudMachineState): boolean {
  return TRANSITIONAL.includes(state);
}

export function cloudRefetchMs(
  machines: readonly Pick<CloudMachine, 'state'>[] | undefined,
): number {
  return machines?.some((m) => isTransitional(m.state)) ? CLOUD_FAST_MS : CLOUD_SLOW_MS;
}

/** GET /api/cloud, polled every 5 s while a machine changes state, else every 30 s. */
export function useCloudOverview(enabled = true): UseQueryResult<CloudOverview> {
  return useQuery({
    queryKey: cloudKey,
    queryFn: ({ signal }) => fetchCloud(signal),
    enabled,
    refetchInterval: (q) => cloudRefetchMs(q.state.data?.machines),
    staleTime: 4_000,
  });
}

// ---------------------------------------------------------------------------
// REST calls

export interface PriceQuery {
  region: AzureRegion;
  diskType: AzureDiskType;
  diskGb: number;
  publicIp: boolean;
}

export function fetchCloud(signal?: AbortSignal): Promise<CloudOverview> {
  return api('/api/cloud', { schema: cloudOverviewSchema, signal });
}

export function fetchAzure(signal?: AbortSignal): Promise<AzureSettings> {
  return api('/api/cloud/azure', { schema: azureSettingsSchema, signal });
}

/** Step-up when credential fields change (azureUpdateNeedsStepUp); api() asks and retries. */
export function saveAzure(body: AzureSettingsRequest): Promise<AzureSettings> {
  return api('/api/cloud/azure', { method: 'PUT', body, schema: azureSettingsSchema });
}

export function testAzure(): Promise<AzureSettings> {
  return api('/api/cloud/azure/test', { method: 'POST', body: {}, schema: azureSettingsSchema });
}

export function fetchAzurePrices(
  q: PriceQuery,
  signal?: AbortSignal,
): Promise<AzurePricesResponse> {
  const p = new URLSearchParams({
    region: q.region,
    diskType: q.diskType,
    diskGb: String(q.diskGb),
    publicIp: String(q.publicIp),
  });
  return api(`/api/cloud/azure/prices?${p.toString()}`, {
    schema: azurePricesResponseSchema,
    signal,
  });
}

export async function createMachine(body: CloudMachineCreateRequest): Promise<CloudMachine> {
  const r = await api('/api/cloud/machines', {
    method: 'POST',
    body,
    schema: cloudMachineResponseSchema,
  });
  return r.machine;
}

/** Machine ids come from the core and match cloudMachineIdSchema; encoded anyway. */
const machinePath = (id: string): string => `/api/cloud/machines/${encodeURIComponent(id)}`;

export async function startMachine(id: string, overBudget = false): Promise<CloudMachine> {
  const r = await api(`${machinePath(id)}/start`, {
    method: 'POST',
    body: { overBudget },
    schema: cloudMachineResponseSchema,
  });
  return r.machine;
}

export async function stopMachine(id: string): Promise<CloudMachine> {
  const r = await api(`${machinePath(id)}/stop`, {
    method: 'POST',
    body: {},
    schema: cloudMachineResponseSchema,
  });
  return r.machine;
}

export async function updateMachine(id: string, idleMinutes: number): Promise<CloudMachine> {
  const r = await api(machinePath(id), {
    method: 'PUT',
    body: { idleMinutes },
    schema: cloudMachineResponseSchema,
  });
  return r.machine;
}

/** Step-up (api() asks); the core checks the name again. */
export async function deleteMachine(id: string, confirmName: string): Promise<CloudMachine> {
  const r = await api(machinePath(id), {
    method: 'DELETE',
    body: { confirmName },
    schema: cloudMachineResponseSchema,
  });
  return r.machine;
}

// ---------------------------------------------------------------------------
// Text and numbers

/** "0,10 €", "6,30 €", "1.024,00 €". */
export function formatEur(v: number): string {
  return `${formatGrouped(v, 2, 2)} €`;
}

/** Hourly price: two digits from 0,10 €, below that up to four ("0,0095 €"). */
export function formatEurHour(v: number): string {
  const digits = v > 0 && v < 0.1 ? 4 : 2;
  return `${formatGrouped(v, 2, digits)} €/Std`;
}

/** Monthly price: whole euros from 10 € ("75 €/Monat"), else two digits ("6,30 €/Monat"). */
export function formatEurMonth(v: number): string {
  return v >= 10 ? `${formatGrouped(Math.round(v), 0, 0)} €/Monat` : `${formatEur(v)}/Monat`;
}

export const COST_SOURCE_TEXT: Record<CloudCost['source'], string> = {
  live: 'Azure-Preis',
  estimate: 'Schätzung',
};

/** "Läuft: 0,10 €/Std · Schläft: 6,30 €/Monat · Dauerbetrieb: 75 €/Monat". */
export function costLine(c: CloudCost): string {
  return [
    `Läuft: ${formatEurHour(c.runningEurPerHour)}`,
    `Schläft: ${formatEurMonth(c.sleepingEurPerMonth)}`,
    `Dauerbetrieb: ${formatEurMonth(c.fullMonthEur)}`,
  ].join(' · ');
}

/** Public IPv4 per month, for the checkbox hint ("ca. 3,36 €/Monat"). */
export const PUBLIC_IP_EUR_PER_MONTH = AZURE_PUBLIC_IP_EUR_PER_HOUR * HOURS_PER_MONTH;

export const DISK_TYPE_LABEL: Record<AzureDiskType, string> = {
  StandardSSD_LRS: 'Standard-SSD',
  Premium_LRS: 'Premium-SSD',
};

export const regionOptions = AZURE_REGIONS.map((r) => ({
  value: r,
  label: AZURE_REGION_LABELS[r],
}));
export const diskTypeOptions = AZURE_DISK_TYPES.map((t) => ({
  value: t,
  label: DISK_TYPE_LABEL[t],
}));
export const diskSizeOptions = AZURE_DISK_SIZES.map((n) => ({
  value: String(n),
  label: `${n} GB`,
}));

export function regionLabel(r: AzureRegion): string {
  return AZURE_REGION_LABELS[r];
}

/** StatusDot of a machine: shape and short tag, the German state text next to it. */
export function machineStatus(state: CloudMachineState): Status {
  if (state === 'running') return 'ok';
  if (state === 'deallocated') return 'off';
  if (state === 'failed') return 'crit';
  return 'busy';
}

export function machineStateText(m: Pick<CloudMachine, 'state' | 'stateText'>): string {
  return m.stateText || CLOUD_MACHINE_STATE_TEXT[m.state];
}

/** "2 vCPU · 8 GB RAM". */
export function sizeSpec(s: { vcpus: number; ramGb: number }): string {
  return `${s.vcpus} vCPU · ${formatNumber(s.ramGb)} GB RAM`;
}

/** "B2ms" for "Standard_B2ms". */
export function shortSize(size: string): string {
  return size.replace(/^Standard_/, '');
}

/** Azure account status as StatusDot. */
export function azureStatus(s: Pick<AzureSettings, 'status'>): { status: Status; label: string } {
  if (s.status === 'ok') return { status: 'ok', label: 'verbunden' };
  if (s.status === 'error') return { status: 'crit', label: 'Fehler' };
  return { status: 'off', label: 'nicht eingerichtet' };
}

export function budgetStatus(b: Pick<CloudBudget, 'state'>): { status: Status; label: string } {
  if (b.state === 'over') return { status: 'crit', label: 'aufgebraucht' };
  if (b.state === 'warn') return { status: 'warn', label: 'bald aufgebraucht' };
  return { status: 'ok', label: 'im Rahmen' };
}

/** Over budget every game start is refused; only the machine start with confirmation works. */
export const OVER_BUDGET_START_HINT =
  'Spiele starten nicht mehr von selbst und auch nicht per Knopf. Starten geht nur noch auf der Seite Cloud mit Bestätigung.';

/** Game start answered 409 over_budget (tile on the game pages). */
export const OVER_BUDGET_GAME_TEXT = 'Cloud-Budget aufgebraucht. Der Cloud-Server startet nicht.';

/** Statussatz of the budget: state first, then the numbers. */
export function budgetText(b: CloudBudget): string {
  const of = `${formatEur(b.monthEur)} von ${formatEur(b.limitEur)}`;
  if (b.state === 'over') {
    return `Budget aufgebraucht: ${of}. ${OVER_BUDGET_START_HINT}`;
  }
  if (b.state === 'warn')
    return `Budget fast aufgebraucht: ${of} (${formatNumber(Math.round(b.percent), 0)} %).`;
  return `Budget im Rahmen: ${of} (${formatNumber(Math.round(b.percent), 0)} %).`;
}

// ---------------------------------------------------------------------------
// Sizes

export type PriceSize = AzurePricesResponse['sizes'][number];

export interface SizeOption {
  size: string;
  vcpus: number;
  ramGb: number;
  cost: CloudCost;
  freeTier: boolean;
  burstable: boolean;
  recommended: boolean;
  /** Why it cannot be chosen (too little RAM), or null. */
  disabledReason: string | null;
  label: string;
}

/** RAM in GB from "4G" or "512M". Unknown: 0. */
export function ramGbOf(ram: unknown): number {
  const m = typeof ram === 'string' ? /^(\d{1,3})([GM])$/.exec(ram) : null;
  if (!m?.[1]) return 0;
  return m[2] === 'G' ? Number(m[1]) : Number(m[1]) / 1024;
}

/**
 * RAM limit of the game like the core's ramLimitFor: the MEMORY field (as typed in the
 * draft, else its default), else the template recommendation.
 */
export function gameRamGb(
  tpl: { ram: { recommended: string }; fields: readonly { key: string; default?: unknown }[] },
  fields: Readonly<Record<string, string | boolean>>,
): number {
  const typed = ramGbOf(fields.MEMORY);
  if (typed > 0) return typed;
  const def = ramGbOf(tpl.fields.find((f) => f.key === 'MEMORY')?.default);
  if (def > 0) return def;
  return ramGbOf(tpl.ram.recommended);
}

/**
 * Sizes for the select: cheapest first, the recommendation marked "Empfohlen", the free
 * account size "Free-Tier", sizes with less RAM than game + OS disabled with a reason.
 */
export function sizeOptions(sizes: readonly PriceSize[], gameRamGb: number): SizeOption[] {
  const need = gameRamGb + CLOUD_OS_RAM_GB;
  const rec = gameRamGb > 0 ? recommendAzureSize(gameRamGb)?.size : undefined;
  return [...sizes]
    .sort((a, b) => a.cost.runningEurPerHour - b.cost.runningEurPerHour || a.ramGb - b.ramGb)
    .map((s) => {
      const tooSmall = gameRamGb > 0 && s.ramGb < need;
      const tags = [s.size === rec ? 'Empfohlen' : null, s.freeTier ? 'Free-Tier' : null].filter(
        Boolean,
      );
      const reason = tooSmall ? `zu wenig RAM, braucht ${formatNumber(need)} GB` : null;
      const label = [
        `${shortSize(s.size)} · ${sizeSpec(s)} · ${formatEurHour(s.cost.runningEurPerHour)}`,
        ...tags,
        ...(reason ? [reason] : []),
      ].join(' · ');
      return {
        size: s.size,
        vcpus: s.vcpus,
        ramGb: s.ramGb,
        cost: s.cost,
        freeTier: s.freeTier,
        burstable: s.burstable,
        recommended: s.size === rec,
        disabledReason: reason,
        label,
      };
    });
}

/** The chosen size while it fits, else the default. */
export function pickSize(options: readonly SizeOption[], chosen: string): string {
  const cur = options.find((o) => o.size === chosen);
  return cur && !cur.disabledReason ? chosen : defaultSize(options);
}

/** Preselection: the recommendation, else the cheapest size that fits. */
export function defaultSize(options: readonly SizeOption[]): string {
  return (
    options.find((o) => o.recommended && !o.disabledReason)?.size ??
    options.find((o) => !o.disabledReason)?.size ??
    ''
  );
}

// ---------------------------------------------------------------------------
// Order form

export interface MachineDraft {
  name: string;
  size: string;
  region: AzureRegion;
  diskType: AzureDiskType;
  diskGb: number;
  publicIp: boolean;
  idleMinutes: string;
}

export function emptyMachineDraft(region: AzureRegion, name = ''): MachineDraft {
  return {
    name,
    size: '',
    region,
    diskType: 'StandardSSD_LRS',
    diskGb: 32,
    publicIp: true,
    idleMinutes: String(CLOUD_IDLE_MINUTES_DEFAULT),
  };
}

/** "hz-" + game name, lowercase, only a–z, 0–9 and "-", at most 32 characters. */
export function defaultMachineName(gameName: string): string {
  const base = gameName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `hz-${base || 'server'}`.slice(0, 32).replace(/-+$/, '');
}

export type MachineErrors = Partial<Record<'name' | 'size' | 'idleMinutes', string>>;

export function idleMinutesError(raw: string): string | null {
  const n = parseLocaleNumber(raw || '0');
  if (!Number.isInteger(n) || n < 0 || n > 1440) return 'Ganze Minuten von 0 bis 1440 (0 = nie).';
  return null;
}

export function validateMachine(
  d: MachineDraft,
  taken: readonly string[] = [],
): { ok: true } | { ok: false; errors: MachineErrors } {
  const errors: MachineErrors = {};
  const name = d.name.trim();
  const parsed = cloudMachineNameSchema.safeParse(name);
  if (!parsed.success) {
    errors.name =
      'Kleinbuchstaben, Ziffern und Bindestrich, 3 bis 32 Zeichen, Anfang ein Buchstabe.';
  } else if (taken.includes(name)) errors.name = 'Diesen Namen gibt es schon.';
  if (!d.size) errors.size = 'Größe auswählen.';
  const idle = idleMinutesError(d.idleMinutes);
  if (idle) errors.idleMinutes = idle;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true };
}

/** Body of POST /api/cloud/machines with the price the admin saw and confirmed. */
export function machineCreateBody(
  d: MachineDraft,
  confirmEurPerHour: number,
  opts: { overBudget?: boolean; game?: CloudPendingGame } = {},
): CloudMachineCreateRequest {
  return {
    provider: 'azure',
    name: d.name.trim(),
    size: d.size,
    region: d.region,
    diskType: d.diskType,
    diskGb: d.diskGb as CloudMachineCreateRequest['diskGb'],
    publicIp: d.publicIp,
    idleMinutes: parseLocaleNumber(d.idleMinutes || '0'),
    confirmEurPerHour,
    overBudget: opts.overBudget ?? false,
    ...(opts.game ? { game: opts.game } : {}),
  };
}

/** Pending game from the game create body: every field but serverId (the core sets it). */
export function pendingGame(body: GameCreateBody): CloudPendingGame {
  return {
    templateId: body.templateId,
    name: body.name,
    values: body.values,
    ports: body.ports,
    autoStopMinutes: body.autoStopMinutes,
    wakeOnConnect: body.wakeOnConnect,
    externalAddress: body.externalAddress,
  };
}

/** Submit allowed: a fitting size, the price ticked and, if needed, the budget override. */
export function orderReady(o: {
  selected: Pick<SizeOption, 'disabledReason'> | undefined;
  confirmed: boolean;
  needsOverBudget: boolean;
  overBudget: boolean;
}): boolean {
  return (
    !!o.selected &&
    o.selected.disabledReason === null &&
    o.confirmed &&
    (!o.needsOverBudget || o.overBudget)
  );
}

/** True while the confirmed price still matches the shown one (rounding tolerance). */
export function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= CLOUD_PRICE_TOLERANCE_EUR;
}

/**
 * Why the core refused an order or start with 409:
 * - `price`: the current price differs from the confirmed one (re-confirm),
 * - `budget`: the month estimate is at or over the budget (second confirmation),
 * - `other`: anything else (show the error text).
 * The codes `price_changed` / `over_budget` decide; for a plain 409 the core's hint,
 * then fresh prices and budget.
 */
export type CloudConflict = 'price' | 'budget' | 'other';

export function cloudConflict(
  err: unknown,
  ctx: { confirmed?: number; current?: number; budget?: Pick<CloudBudget, 'state'> },
): CloudConflict {
  if (isApiError(err, 'price_changed')) return 'price';
  if (isApiError(err, 'over_budget')) return 'budget';
  if (!isApiError(err) || err.status !== 409) return 'other';
  // Older core without the M22 codes: 409 conflict with a hint, or fresh numbers decide.
  const hint = err.hint?.toLowerCase() ?? '';
  if (hint.includes('budget')) return 'budget';
  if (hint.includes('preis')) return 'price';
  if (
    ctx.confirmed !== undefined &&
    ctx.current !== undefined &&
    !samePrice(ctx.confirmed, ctx.current)
  ) {
    return 'price';
  }
  if (ctx.budget?.state === 'over') return 'budget';
  return 'other';
}

// ---------------------------------------------------------------------------
// Azure account form (write-only secrets)

export interface AzureForm {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  region: AzureRegion;
  tailscaleAuthKey: string;
  budgetEurPerMonth: string;
}

export type AzureFormErrors = Partial<Record<keyof AzureForm, string>>;

/** Secrets are never in the settings, so their inputs start empty. */
export function azureToForm(s: AzureSettings): AzureForm {
  return {
    tenantId: s.tenantId ?? '',
    clientId: s.clientId ?? '',
    clientSecret: '',
    subscriptionId: s.subscriptionId ?? '',
    resourceGroup: s.resourceGroup ?? '',
    region: s.region,
    tailscaleAuthKey: '',
    budgetEurPerMonth: formatNumber(s.budgetEurPerMonth, 2),
  };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_ERROR = 'GUID erwartet, z. B. 00000000-0000-0000-0000-000000000000.';

/**
 * Only changed fields go into the PUT. Empty secret inputs mean "unchanged". A cleared
 * id field cannot be sent (the contract has no null), so it is an error.
 */
export function buildAzurePatch(
  s: AzureSettings,
  f: AzureForm,
): { patch: AzureSettingsRequest; errors: AzureFormErrors } {
  const patch: AzureSettingsRequest = {};
  const errors: AzureFormErrors = {};
  for (const k of ['tenantId', 'clientId', 'subscriptionId'] as const) {
    const v = f[k].trim().toLowerCase();
    if (v === (s[k] ?? '')) continue;
    if (!GUID_RE.test(v)) errors[k] = GUID_ERROR;
    else patch[k] = v;
  }
  const group = f.resourceGroup.trim();
  if (group !== (s.resourceGroup ?? '')) {
    const r = azureResourceGroupSchema.safeParse(group);
    if (!r.success) errors.resourceGroup = 'Buchstaben, Ziffern, . _ - ( ), höchstens 90 Zeichen.';
    else patch.resourceGroup = r.data;
  }
  if (f.region !== s.region) patch.region = f.region;
  if (f.clientSecret) {
    if (!azureClientSecretSchema.safeParse(f.clientSecret).success) {
      errors.clientSecret = 'Secret: 10 bis 200 Zeichen ohne Leerzeichen.';
    } else patch.clientSecret = f.clientSecret;
  }
  if (f.tailscaleAuthKey) {
    const key = f.tailscaleAuthKey.trim();
    if (!tailscaleAuthKeySchema.safeParse(key).success) {
      errors.tailscaleAuthKey = 'Tailscale-Auth-Key erwartet (tskey-auth-…).';
    } else patch.tailscaleAuthKey = key;
  }
  const budget = parseLocaleNumber(f.budgetEurPerMonth);
  if (!Number.isFinite(budget) || budget < 1 || budget > 10_000) {
    errors.budgetEurPerMonth = 'Betrag von 1 bis 10.000 €.';
  } else if (Math.abs(budget - s.budgetEurPerMonth) > 0.001) {
    patch.budgetEurPerMonth = Math.round(budget * 100) / 100;
  }
  return { patch, errors };
}

/** tenant, app or subscription change without a new secret: the core drops the stored one. */
export function dropsSecret(s: AzureSettings, patch: AzureSettingsRequest): boolean {
  return (
    s.secretSet &&
    patch.clientSecret === undefined &&
    (patch.tenantId !== undefined ||
      patch.clientId !== undefined ||
      patch.subscriptionId !== undefined)
  );
}
