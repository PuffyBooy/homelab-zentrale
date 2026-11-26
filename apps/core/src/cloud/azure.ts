import { createHash, generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import {
  AZURE_VM_SIZE_NAMES,
  azureClientSecretSchema,
  azureDiskGbSchema,
  azureDiskTypeSchema,
  azureRegionSchema,
  azureResourceGroupSchema,
  azureVmSizeSchema,
  cloudMachineNameSchema,
  type AzureDiskType,
  type AzureRegion,
  type CloudErrorText,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';

/**
 * Azure client of the cloud module (M22). Rules (packages/shared/src/api/cloud.ts):
 * - only the three fixed hosts; overrides only with HZ_DEMO=1 and only to
 *   http://127.0.0.1:<port> (tests and e2e talk to a fake Azure);
 * - every path part comes from a value that passed its schema and is URL-encoded;
 * - no redirects, hard timeout, response cap;
 * - failures become one of the fixed CLOUD_ERRORS. The client secret, the access token,
 *   remote bodies and the VM's customData never reach an error or a log line.
 * Long-running Azure operations are never awaited here: the service polls the
 * provisioningState / power state of the resource from its tick. Remote URLs
 * (Azure-AsyncOperation, Location) are never followed.
 */

export type AzureFetch = (url: string, init: RequestInit) => Promise<Response>;

export const AZURE_LOGIN = 'https://login.microsoftonline.com';
export const AZURE_MANAGEMENT = 'https://management.azure.com';
export const AZURE_PRICES = 'https://prices.azure.com';
export const AZURE_SCOPE = 'https://management.azure.com/.default';

export const API_COMPUTE = '2024-07-01';
export const API_DISKS = '2024-03-02';
export const API_NETWORK = '2024-05-01';
export const API_RESOURCES = '2021-04-01';

export const AZURE_TIMEOUT_MS = 20_000;
export const AZURE_MAX_BYTES = 2 * 1024 * 1024;
/** Cached access token is dropped this long before it expires. */
export const TOKEN_MARGIN_MS = 5 * 60_000;
export const PRICE_CACHE_MS = 24 * 60 * 60_000;
/** After a failed price fetch the estimate is used this long before the next try. */
export const PRICE_RETRY_MS = 10 * 60_000;
const PRICE_MAX_PAGES = 5;

export const VNET_PREFIX = '10.77.0.0/16';
export const SUBNET_PREFIX = '10.77.0.0/24';
export const ADMIN_USER = 'hzadmin';
export const UBUNTU_IMAGE = {
  publisher: 'Canonical',
  offer: 'ubuntu-24_04-lts',
  sku: 'server',
  version: 'latest',
} as const;

export interface AzureEndpoints {
  login: string;
  management: string;
  prices: string;
}

const LOOPBACK_OVERRIDE = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;

function override(fixed: string, value: string | undefined, demo: boolean): string {
  if (!demo || value === undefined) return fixed;
  const m = LOOPBACK_OVERRIDE.exec(value);
  if (!m) return fixed;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? value : fixed;
}

/** The fixed Azure hosts, or loopback overrides when HZ_DEMO=1 (tests, e2e). */
export function azureEndpoints(config: Pick<Config, 'demo' | 'azureOverrides'>): AzureEndpoints {
  const o = config.azureOverrides;
  return {
    login: override(AZURE_LOGIN, o.login, config.demo),
    management: override(AZURE_MANAGEMENT, o.management, config.demo),
    prices: override(AZURE_PRICES, o.prices, config.demo),
  };
}

export class AzureError extends Error {
  constructor(
    readonly text: CloudErrorText,
    /** Retrying later may help (network, timeout, throttling, 5xx). */
    readonly transient = false,
  ) {
    super(text);
    this.name = 'AzureError';
  }
}

/** Everything the client needs; validated before it is used in a path. */
export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
}

const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const credentialsSchema = z.object({
  tenantId: guid,
  clientId: guid,
  clientSecret: azureClientSecretSchema,
  subscriptionId: guid,
  resourceGroup: azureResourceGroupSchema,
});

/** One path segment from a validated value (encoded anyway). */
function seg(v: string): string {
  if (v === '' || v === '.' || v === '..' || /[/\\?#%]/.test(v)) {
    throw new AzureError('Unerwartete Antwort von Azure');
  }
  return encodeURIComponent(v);
}

function checkName(name: string): string {
  const p = cloudMachineNameSchema.safeParse(name);
  if (!p.success || p.data !== name) throw new AzureError('Unerwartete Antwort von Azure');
  return name;
}

function checkRegion(region: string): AzureRegion {
  const p = azureRegionSchema.safeParse(region);
  if (!p.success) throw new AzureError('Unerwartete Antwort von Azure');
  return p.data;
}

export type ResourceKind = 'vnet' | 'nsg' | 'ip' | 'nic' | 'vm' | 'disk';

/** Resource names of a machine (fixed suffixes). */
export function resourceName(kind: ResourceKind, name: string, region: AzureRegion): string {
  switch (kind) {
    case 'vnet':
      return `hz-vnet-${region}`;
    case 'nsg':
      return `${name}-nsg`;
    case 'ip':
      return `${name}-ip`;
    case 'nic':
      return `${name}-nic`;
    case 'vm':
      return name;
    case 'disk':
      return `${name}-disk`;
  }
}

const PROVIDER: Record<ResourceKind, { type: string; api: string }> = {
  vnet: { type: 'Microsoft.Network/virtualNetworks', api: API_NETWORK },
  nsg: { type: 'Microsoft.Network/networkSecurityGroups', api: API_NETWORK },
  ip: { type: 'Microsoft.Network/publicIPAddresses', api: API_NETWORK },
  nic: { type: 'Microsoft.Network/networkInterfaces', api: API_NETWORK },
  vm: { type: 'Microsoft.Compute/virtualMachines', api: API_COMPUTE },
  disk: { type: 'Microsoft.Compute/disks', api: API_DISKS },
};

export interface NsgRule {
  proto: 'tcp' | 'udp';
  port: number;
}

export interface VmSpec {
  name: string;
  region: AzureRegion;
  size: string;
  diskType: AzureDiskType;
  diskGb: number;
  publicIp: boolean;
  /** Base64 of the cloud-init document. Never logged. */
  customData: string;
}

/** Provisioning state of a resource, or null when it does not exist (404). */
export type ProvisioningState = 'Succeeded' | 'Failed' | 'Canceled' | 'InProgress' | null;
export type PowerState =
  'running' | 'starting' | 'stopping' | 'stopped' | 'deallocating' | 'deallocated' | 'unknown';

const errorBodySchema = z.object({
  error: z.object({ code: z.string().max(200).optional() }).optional(),
});

/** Fixed text for an Azure HTTP failure, from the status and the error code only. */
export function azureErrorFor(status: number, body: string): AzureError {
  let code: string;
  try {
    const p = errorBodySchema.safeParse(JSON.parse(body));
    code = (p.success ? p.data.error?.code : undefined) ?? '';
  } catch {
    code = '';
  }
  if (/AADSTS/.test(body) || status === 401 || code === 'InvalidAuthenticationToken') {
    return new AzureError('Zugangsdaten ungültig');
  }
  if (code === 'ResourceGroupNotFound') return new AzureError('Ressourcengruppe nicht gefunden');
  if (code === 'SkuNotAvailable' || (code === 'InvalidTemplateDeployment' && /Sku/.test(body))) {
    return new AzureError('Größe in der Region nicht verfügbar');
  }
  if (
    code === 'QuotaExceeded' ||
    code === 'OperationNotAllowed' ||
    code === 'PublicIPCountLimitReached'
  ) {
    return new AzureError('Kontingent der Region erschöpft');
  }
  if (status === 403 || code === 'AuthorizationFailed' || code === 'LinkedAuthorizationFailed') {
    return new AzureError('Keine Berechtigung in der Ressourcengruppe');
  }
  if (status === 429 || status >= 500) return new AzureError('Azure nicht erreichbar', true);
  return new AzureError('Unerwartete Antwort von Azure');
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new AzureError('Unerwartete Antwort von Azure');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AzureError('Unerwartete Antwort von Azure');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface RawResponse {
  status: number;
  body: string;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(20_000),
  expires_in: z.coerce.number().int().positive().max(86_400),
});

const provisioningSchema = z.object({
  properties: z.object({ provisioningState: z.string().max(40).optional() }).optional(),
});

const instanceViewSchema = z.object({
  statuses: z
    .array(z.object({ code: z.string().max(100).optional() }))
    .max(20)
    .optional(),
});

const publicIpSchema = z.object({
  properties: z.object({ ipAddress: z.ipv4().optional() }).optional(),
});

const pricePageSchema = z.object({
  Items: z
    .array(
      z.object({
        armSkuName: z.string().max(100).optional(),
        armRegionName: z.string().max(100).optional(),
        retailPrice: z.number().nonnegative().optional(),
        unitOfMeasure: z.string().max(40).optional(),
        productName: z.string().max(200).optional(),
        skuName: z.string().max(200).optional(),
        meterName: z.string().max(200).optional(),
        type: z.string().max(40).optional(),
        currencyCode: z.string().max(10).optional(),
      }),
    )
    .max(1000),
  NextPageLink: z.string().max(2000).nullable().optional(),
});

/** SSH public key in OpenSSH format; the private key is never exported. */
export function throwawaySshPublicKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('rsa key');
  const str = (b: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  const mpint = (b64url: string): Buffer => {
    let b = Buffer.from(b64url, 'base64url');
    if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return str(b);
  };
  const blob = Buffer.concat([str(Buffer.from('ssh-rsa')), mpint(jwk.e), mpint(jwk.n)]);
  return `ssh-rsa ${blob.toString('base64')} hz-throwaway`;
}

export interface AzureClientOptions {
  fetch: AzureFetch;
  endpoints: AzureEndpoints;
  now: Clock;
  timeoutMs?: number;
}

/**
 * Azure Resource Manager and Retail Prices. The token of the client credentials
 * flow is cached per tenant/app/secret until TOKEN_MARGIN_MS before it expires.
 */
export class AzureClient {
  private token: { key: string; value: string; expiresAt: number } | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AzureClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? AZURE_TIMEOUT_MS;
  }

  get endpoints(): AzureEndpoints {
    return this.opts.endpoints;
  }

  /** Forget the cached token (settings changed). */
  dropToken(): void {
    this.token = null;
  }

  private async send(url: string, init: RequestInit): Promise<RawResponse> {
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AzureError('Zeitüberschreitung', true);
      }
      throw new AzureError('Azure nicht erreichbar', true);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new AzureError('Unerwartete Antwort von Azure');
    }
    let body: string;
    try {
      body = await readCapped(res, AZURE_MAX_BYTES);
    } catch (err) {
      if (err instanceof AzureError) throw err;
      throw new AzureError('Azure nicht erreichbar', true);
    }
    return { status: res.status, body };
  }

  private static check(c: AzureCredentials): AzureCredentials {
    const p = credentialsSchema.safeParse(c);
    if (!p.success) throw new AzureError('Zugangsdaten ungültig');
    return p.data;
  }

  /** Bearer token (client credentials). Cached; never logged or returned. */
  async accessToken(creds: AzureCredentials): Promise<string> {
    const c = AzureClient.check(creds);
    const key = createHash('sha256')
      .update(`${c.tenantId}\n${c.clientId}\n${c.clientSecret}`)
      .digest('hex');
    const now = this.opts.now();
    if (this.token && this.token.key === key && this.token.expiresAt - TOKEN_MARGIN_MS > now) {
      return this.token.value;
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      scope: AZURE_SCOPE,
    });
    const res = await this.send(
      `${this.opts.endpoints.login}/${seg(c.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    );
    if (res.status !== 200) {
      if (res.status === 400 || res.status === 401 || /AADSTS/.test(res.body)) {
        throw new AzureError('Zugangsdaten ungültig');
      }
      throw azureErrorFor(res.status, res.body);
    }
    let parsed: z.infer<typeof tokenSchema>;
    try {
      const p = tokenSchema.safeParse(JSON.parse(res.body));
      if (!p.success) throw new Error('shape');
      parsed = p.data;
    } catch {
      throw new AzureError('Unerwartete Antwort von Azure');
    }
    this.token = { key, value: parsed.access_token, expiresAt: now + parsed.expires_in * 1000 };
    return parsed.access_token;
  }

  private groupPath(c: AzureCredentials): string {
    return `/subscriptions/${seg(c.subscriptionId)}/resourceGroups/${seg(c.resourceGroup)}`;
  }

  /** ARM id of a resource (built locally, never taken from a response). */
  resourceId(
    creds: AzureCredentials,
    kind: ResourceKind,
    name: string,
    region: AzureRegion,
  ): string {
    const c = AzureClient.check(creds);
    return `${this.groupPath(c)}/providers/${PROVIDER[kind].type}/${seg(
      resourceName(kind, checkName(name), checkRegion(region)),
    )}`;
  }

  private async arm(
    creds: AzureCredentials,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    api: string,
    body?: unknown,
  ): Promise<RawResponse> {
    const token = await this.accessToken(creds);
    return this.send(`${this.opts.endpoints.management}${path}?api-version=${api}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private static ok(res: RawResponse, allowed: number[] = [200, 201, 202, 204]): RawResponse {
    if (allowed.includes(res.status)) return res;
    throw azureErrorFor(res.status, res.body);
  }

  private static json(res: RawResponse): unknown {
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new AzureError('Unerwartete Antwort von Azure');
    }
  }

  /** Token plus a read of the resource group (account test). */
  async testAccess(creds: AzureCredentials): Promise<void> {
    const c = AzureClient.check(creds);
    const res = await this.arm(c, 'GET', this.groupPath(c), API_RESOURCES);
    if (res.status === 404) throw new AzureError('Ressourcengruppe nicht gefunden');
    AzureClient.ok(res, [200]);
  }

  async provisioningState(
    creds: AzureCredentials,
    kind: ResourceKind,
    name: string,
    region: AzureRegion,
  ): Promise<ProvisioningState> {
    const res = await this.arm(
      creds,
      'GET',
      this.resourceId(creds, kind, name, region),
      PROVIDER[kind].api,
    );
    if (res.status === 404) return null;
    AzureClient.ok(res, [200]);
    const p = provisioningSchema.safeParse(AzureClient.json(res));
    const s = p.success ? p.data.properties?.provisioningState : undefined;
    if (s === 'Succeeded' || s === 'Failed' || s === 'Canceled') return s;
    return 'InProgress';
  }

  async putVnet(creds: AzureCredentials, region: AzureRegion): Promise<void> {
    const r = checkRegion(region);
    AzureClient.ok(
      await this.arm(creds, 'PUT', this.vnetPath(creds, r), API_NETWORK, {
        location: r,
        properties: {
          addressSpace: { addressPrefixes: [VNET_PREFIX] },
          subnets: [{ name: 'default', properties: { addressPrefix: SUBNET_PREFIX } }],
        },
      }),
    );
  }

  private vnetPath(creds: AzureCredentials, region: AzureRegion): string {
    const c = AzureClient.check(creds);
    return `${this.groupPath(c)}/providers/${PROVIDER.vnet.type}/${seg(resourceName('vnet', 'x', region))}`;
  }

  /** NSG with exactly these inbound rules (Azure's defaults deny the rest from the internet). */
  async putNsg(
    creds: AzureCredentials,
    name: string,
    region: AzureRegion,
    rules: readonly NsgRule[],
  ): Promise<void> {
    const r = checkRegion(region);
    AzureClient.ok(
      await this.arm(
        creds,
        'PUT',
        this.resourceId(creds, 'nsg', name, r),
        API_NETWORK,
        nsgBody(r, rules),
      ),
    );
  }

  async putPublicIp(creds: AzureCredentials, name: string, region: AzureRegion): Promise<void> {
    const r = checkRegion(region);
    AzureClient.ok(
      await this.arm(creds, 'PUT', this.resourceId(creds, 'ip', name, r), API_NETWORK, {
        location: r,
        sku: { name: 'Standard', tier: 'Regional' },
        properties: { publicIPAllocationMethod: 'Static', publicIPAddressVersion: 'IPv4' },
      }),
    );
  }

  async publicIpAddress(
    creds: AzureCredentials,
    name: string,
    region: AzureRegion,
  ): Promise<string | null> {
    const res = await this.arm(
      creds,
      'GET',
      this.resourceId(creds, 'ip', name, region),
      API_NETWORK,
    );
    if (res.status === 404) return null;
    AzureClient.ok(res, [200]);
    const p = publicIpSchema.safeParse(AzureClient.json(res));
    return p.success ? (p.data.properties?.ipAddress ?? null) : null;
  }

  async putNic(
    creds: AzureCredentials,
    name: string,
    region: AzureRegion,
    publicIp: boolean,
  ): Promise<void> {
    const r = checkRegion(region);
    const subnetId = `${this.vnetPath(creds, r)}/subnets/default`;
    AzureClient.ok(
      await this.arm(creds, 'PUT', this.resourceId(creds, 'nic', name, r), API_NETWORK, {
        location: r,
        properties: {
          networkSecurityGroup: { id: this.resourceId(creds, 'nsg', name, r) },
          ipConfigurations: [
            {
              name: 'ipconfig1',
              properties: {
                subnet: { id: subnetId },
                privateIPAllocationMethod: 'Dynamic',
                ...(publicIp
                  ? {
                      publicIPAddress: {
                        id: this.resourceId(creds, 'ip', name, r),
                        properties: { deleteOption: 'Delete' },
                      },
                    }
                  : {}),
              },
            },
          ],
        },
      }),
    );
  }

  async putVm(creds: AzureCredentials, spec: VmSpec): Promise<void> {
    AzureClient.ok(
      await this.arm(
        creds,
        'PUT',
        this.resourceId(creds, 'vm', spec.name, spec.region),
        API_COMPUTE,
        vmBody(spec, this.resourceId(creds, 'nic', spec.name, spec.region)),
      ),
    );
  }

  async powerState(
    creds: AzureCredentials,
    name: string,
    region: AzureRegion,
  ): Promise<PowerState | null> {
    const res = await this.arm(
      creds,
      'GET',
      `${this.resourceId(creds, 'vm', name, region)}/instanceView`,
      API_COMPUTE,
    );
    if (res.status === 404) return null;
    AzureClient.ok(res, [200]);
    const p = instanceViewSchema.safeParse(AzureClient.json(res));
    const code = (p.success ? (p.data.statuses ?? []) : [])
      .map((s) => s.code ?? '')
      .find((c) => c.startsWith('PowerState/'));
    const v = code?.slice('PowerState/'.length);
    switch (v) {
      case 'running':
      case 'starting':
      case 'stopping':
      case 'stopped':
      case 'deallocating':
      case 'deallocated':
        return v;
      default:
        return 'unknown';
    }
  }

  async start(creds: AzureCredentials, name: string, region: AzureRegion): Promise<void> {
    AzureClient.ok(
      await this.arm(
        creds,
        'POST',
        `${this.resourceId(creds, 'vm', name, region)}/start`,
        API_COMPUTE,
      ),
    );
  }

  async deallocate(creds: AzureCredentials, name: string, region: AzureRegion): Promise<void> {
    AzureClient.ok(
      await this.arm(
        creds,
        'POST',
        `${this.resourceId(creds, 'vm', name, region)}/deallocate`,
        API_COMPUTE,
      ),
    );
  }

  /** DELETE; a missing resource counts as deleted. Returns true when it is gone already. */
  async remove(
    creds: AzureCredentials,
    kind: Exclude<ResourceKind, 'vnet'>,
    name: string,
    region: AzureRegion,
  ): Promise<boolean> {
    const res = await this.arm(
      creds,
      'DELETE',
      this.resourceId(creds, kind, name, region),
      PROVIDER[kind].api,
    );
    if (res.status === 404 || res.status === 204) return true;
    AzureClient.ok(res, [200, 202]);
    return false;
  }

  /**
   * Linux pay-as-you-go prices per hour in EUR for the fixed size list in one region.
   * Spot, Low Priority and Windows meters are skipped. Missing sizes are absent.
   */
  async retailPrices(region: AzureRegion): Promise<Map<string, number>> {
    const r = checkRegion(region);
    const skus = AZURE_VM_SIZE_NAMES.map((s) => `armSkuName eq '${s}'`).join(' or ');
    const filter = `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and armRegionName eq '${r}' and (${skus})`;
    const base = this.opts.endpoints.prices;
    let url: string | null =
      `${base}/api/retail/prices?currencyCode='EUR'&$filter=${encodeURIComponent(filter)}`;
    const out = new Map<string, number>();
    for (let page = 0; url !== null && page < PRICE_MAX_PAGES; page++) {
      const res = await this.send(url, { method: 'GET', headers: { accept: 'application/json' } });
      if (res.status !== 200) throw azureErrorFor(res.status, res.body);
      const p = pricePageSchema.safeParse(AzureClient.json(res));
      if (!p.success) throw new AzureError('Unerwartete Antwort von Azure');
      for (const item of p.data.Items) {
        const sku = azureVmSizeSchema.safeParse(item.armSkuName);
        if (!sku.success || item.armRegionName !== r) continue;
        if (item.currencyCode !== undefined && item.currencyCode !== 'EUR') continue;
        if (item.type !== undefined && item.type !== 'Consumption') continue;
        if (item.unitOfMeasure !== '1 Hour' || item.retailPrice === undefined) continue;
        const names = `${item.productName ?? ''} ${item.skuName ?? ''} ${item.meterName ?? ''}`;
        if (/windows|spot|low priority/i.test(names)) continue;
        if (item.retailPrice <= 0) continue;
        // Several Linux meters for one size: take the higher one (never underestimate).
        out.set(sku.data, Math.max(out.get(sku.data) ?? 0, item.retailPrice));
      }
      url = nextPriceUrl(p.data.NextPageLink ?? null, base);
    }
    return out;
  }
}

/** Follows a price page link only on the prices host and path. */
function nextPriceUrl(link: string | null, base: string): string | null {
  if (link === null || link === '') return null;
  try {
    const u = new URL(link);
    const b = new URL(base);
    if (u.origin !== b.origin || u.pathname !== '/api/retail/prices' || u.username || u.password) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Only the given game ports, inbound, from anywhere. Never 22, never a port outside 1..65535. */
export function nsgRules(rules: readonly NsgRule[]): NsgRule[] {
  const seen = new Set<string>();
  const out: NsgRule[] = [];
  for (const r of rules) {
    if (r.proto !== 'tcp' && r.proto !== 'udp') continue;
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535 || r.port === 22) continue;
    const k = `${r.proto}:${r.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ proto: r.proto, port: r.port });
  }
  return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto)).slice(0, 100);
}

export function nsgBody(region: AzureRegion, rules: readonly NsgRule[]): unknown {
  return {
    location: region,
    properties: {
      securityRules: nsgRules(rules).map((r, i) => ({
        name: `hz-game-${r.proto}-${r.port}`,
        properties: {
          priority: 1000 + i,
          direction: 'Inbound',
          access: 'Allow',
          protocol: r.proto === 'tcp' ? 'Tcp' : 'Udp',
          sourceAddressPrefix: 'Internet',
          sourcePortRange: '*',
          destinationAddressPrefix: '*',
          destinationPortRange: String(r.port),
        },
      })),
    },
  };
}

export function vmBody(spec: VmSpec, nicId: string): unknown {
  const name = checkName(spec.name);
  const region = checkRegion(spec.region);
  const size = azureVmSizeSchema.parse(spec.size);
  const diskType = azureDiskTypeSchema.parse(spec.diskType);
  const diskGb = azureDiskGbSchema.parse(spec.diskGb);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spec.customData)) throw new Error('custom data');
  return {
    location: region,
    properties: {
      hardwareProfile: { vmSize: size },
      storageProfile: {
        imageReference: { ...UBUNTU_IMAGE },
        osDisk: {
          name: resourceName('disk', name, region),
          createOption: 'FromImage',
          diskSizeGB: diskGb,
          managedDisk: { storageAccountType: diskType },
          deleteOption: 'Delete',
        },
      },
      osProfile: {
        computerName: name,
        adminUsername: ADMIN_USER,
        customData: spec.customData,
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          provisionVMAgent: true,
          ssh: {
            publicKeys: [
              {
                path: `/home/${ADMIN_USER}/.ssh/authorized_keys`,
                keyData: throwawaySshPublicKey(),
              },
            ],
          },
        },
      },
      networkProfile: {
        networkInterfaces: [{ id: nicId, properties: { primary: true, deleteOption: 'Delete' } }],
      },
    },
  };
}
