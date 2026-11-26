import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stand-in for the parts of Azure the cloud module (M22) uses: the Entra ID token
 * endpoint (client credentials), Azure Resource Manager (resource group, VNet, NSG,
 * public IP, NIC, VM with start/deallocate/instanceView, disks) and the Retail Prices
 * API. Paths and shapes follow the real APIs. Two ways to use it:
 * - `fetch` as an in-process transport (core tests inject it as AppDeps.cloudFetch;
 *   the URLs still carry the fixed Azure hosts, which are recorded);
 * - `start()` as an HTTP server on 127.0.0.1 for e2e (the core then needs HZ_DEMO=1 and
 *   HZ_AZURE_LOGIN_URL / HZ_AZURE_MANAGEMENT_URL / HZ_AZURE_PRICES_URL = its url).
 */

// Split so secret scanners stay quiet; test values only.
export const FAKE_AZURE_TENANT = '11111111-2222-3333-4444-555555555555';
export const FAKE_AZURE_CLIENT = '66666666-7777-8888-9999-aaaaaaaaaaaa';
export const FAKE_AZURE_SUBSCRIPTION = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
export const FAKE_AZURE_GROUP = 'hz-cloud';
export const FAKE_AZURE_SECRET = ['fake', 'azure', 'client', 'secret', 'e2e0123'].join('~');
export const FAKE_TAILSCALE_KEY = ['tskey', 'auth', 'kFAKE0e2e0CNTRL0abcdefghijkl'].join('-');

export interface FakeRequest {
  method: string;
  /** Origin of the URL (fixed Azure host in-process, 127.0.0.1 over HTTP). */
  origin: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

interface Resource {
  type: string;
  name: string;
  body: Record<string, unknown>;
  /** GETs left until provisioningState Succeeded. */
  polls: number;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ARM_RE =
  /^\/subscriptions\/([^/]+)\/resource[gG]roups\/([^/]+)(?:\/providers\/(Microsoft\.[A-Za-z]+\/[A-Za-z]+)\/([^/]+)(?:\/([A-Za-z]+))?)?$/;

/** Default Linux pay-as-you-go prices (EUR per hour) the fake answers. */
export const FAKE_PRICES: Record<string, number> = {
  Standard_B2ats_v2: 0.0096,
  Standard_B2s: 0.0464,
  Standard_B2ms: 0.0928,
  Standard_B4ms: 0.1856,
  Standard_D2as_v5: 0.0992,
  Standard_D4as_v5: 0.1984,
  Standard_E2as_v5: 0.1344,
  Standard_E4as_v5: 0.2688,
};

export class FakeAzure {
  tenant = FAKE_AZURE_TENANT;
  clientId = FAKE_AZURE_CLIENT;
  clientSecret = FAKE_AZURE_SECRET;
  subscription = FAKE_AZURE_SUBSCRIPTION;
  group = FAKE_AZURE_GROUP;
  /** GETs a new resource stays "Creating"/"Updating". */
  provisionPolls = 0;
  /** Prices per size; `null`: the prices API answers 503. */
  prices: Record<string, number> | null = { ...FAKE_PRICES };
  /** Test hook: answer a request differently (e.g. 403 AuthorizationFailed). */
  override: ((req: FakeRequest) => FakeReply | null) | null = null;
  /** Called after start/deallocate (tests reconnect or close the simulated agent). */
  onPower: ((vm: string, state: 'running' | 'deallocated') => void) | null = null;

  readonly requests: FakeRequest[] = [];
  readonly resources = new Map<string, Resource>();
  readonly power = new Map<string, 'running' | 'deallocated'>();
  private readonly tokens = new Set<string>();
  private tokenSeq = 0;
  private server: Server | null = null;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** In-process transport with the signature of fetch. */
  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? init.body : '';
    const r = this.handle({
      method: init.method ?? 'GET',
      origin: u.origin,
      path: u.pathname,
      query: u.search,
      headers,
      body,
    });
    const text = r.body === undefined ? null : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const r = this.handle({
          method: req.method ?? 'GET',
          origin: this.url,
          path: u.pathname,
          query: u.search,
          headers: flatHeaders(req.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
        res.end(r.body === undefined || r.status === 204 ? undefined : JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => this.server?.listen(port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  // ---- inspection -------------------------------------------------------------------

  private key(type: string, name: string): string {
    return `${type.toLowerCase()}/${name.toLowerCase()}`;
  }

  resource(type: string, name: string): Resource | undefined {
    return this.resources.get(this.key(type, name));
  }

  /** Body of the VM PUT (null before). */
  vm(name: string): Record<string, unknown> | null {
    return this.resource('Microsoft.Compute/virtualMachines', name)?.body ?? null;
  }

  /** Decoded cloud-init of a VM. */
  cloudInit(name: string): string | null {
    const vm = this.vm(name) as { properties?: { osProfile?: { customData?: string } } } | null;
    const cd = vm?.properties?.osProfile?.customData;
    return typeof cd === 'string' ? Buffer.from(cd, 'base64').toString('utf8') : null;
  }

  /** Onboarding code from the one-liner inside the cloud-init. */
  onboardingCode(name: string): string | null {
    return (
      /sh -s -- ([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})/.exec(this.cloudInit(name) ?? '')?.[1] ??
      null
    );
  }

  /** Inbound rules of the machine's NSG as `tcp/25565`. */
  nsgPorts(name: string): string[] {
    const nsg = this.resource('Microsoft.Network/networkSecurityGroups', `${name}-nsg`);
    const rules = ((nsg?.body.properties as { securityRules?: unknown[] } | undefined)
      ?.securityRules ?? []) as {
      properties: { protocol: string; destinationPortRange: string; access: string };
    }[];
    return rules
      .filter((r) => r.properties.access === 'Allow')
      .map((r) => `${r.properties.protocol.toLowerCase()}/${r.properties.destinationPortRange}`)
      .sort();
  }

  /** Names of the resources that still exist, e.g. `networkInterfaces/mc-nic`. */
  names(): string[] {
    return [...this.resources.values()].map((r) => `${r.type.split('/')[1]}/${r.name}`).sort();
  }

  // ---- handler ----------------------------------------------------------------------

  handle(req: FakeRequest): FakeReply {
    this.requests.push(req);
    const o = this.override?.(req);
    if (o) return o;
    if (req.path.endsWith('/oauth2/v2.0/token')) return this.token(req);
    if (req.path === '/api/retail/prices') return this.priceReply(req);
    const m = ARM_RE.exec(req.path);
    if (!m) return { status: 404, body: { error: { code: 'NotFound' } } };
    if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
      return { status: 401, body: { error: { code: 'InvalidAuthenticationToken' } } };
    }
    const [, sub, group, type, rawName, action] = m;
    if (sub !== this.subscription) {
      return { status: 404, body: { error: { code: 'SubscriptionNotFound' } } };
    }
    if (decodeURIComponent(group ?? '') !== this.group) {
      return { status: 404, body: { error: { code: 'ResourceGroupNotFound' } } };
    }
    if (!type || !rawName) {
      return req.method === 'GET'
        ? { status: 200, body: { name: this.group, location: 'germanywestcentral' } }
        : { status: 405 };
    }
    const name = decodeURIComponent(rawName);
    return this.resourceReply(req, type, name, action);
  }

  private token(req: FakeRequest): FakeReply {
    const tenant = req.path.split('/')[1];
    const form = new URLSearchParams(req.body);
    if (
      tenant !== this.tenant ||
      form.get('client_id') !== this.clientId ||
      form.get('client_secret') !== this.clientSecret ||
      form.get('grant_type') !== 'client_credentials' ||
      form.get('scope') !== 'https://management.azure.com/.default'
    ) {
      return {
        status: 401,
        body: {
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret.',
        },
      };
    }
    this.tokenSeq += 1;
    const token = `fake-arm-token-${this.tokenSeq}`;
    this.tokens.add(token);
    return { status: 200, body: { token_type: 'Bearer', expires_in: 3599, access_token: token } };
  }

  private priceReply(req: FakeRequest): FakeReply {
    if (this.prices === null) return { status: 503, body: {} };
    const q = new URLSearchParams(req.query);
    const filter = q.get('$filter') ?? '';
    const region = /armRegionName eq '([a-z]+)'/.exec(filter)?.[1] ?? '';
    const items = Object.entries(this.prices).flatMap(([sku, price]) => [
      {
        currencyCode: 'EUR',
        retailPrice: price,
        armRegionName: region,
        armSkuName: sku,
        productName: `Virtual Machines ${sku.split('_')[1]} Series`,
        skuName: sku.replace('Standard_', '').replace(/_/g, ' '),
        meterName: sku.replace('Standard_', ''),
        unitOfMeasure: '1 Hour',
        type: 'Consumption',
      },
      // Windows and Spot meters: the core must skip them.
      {
        currencyCode: 'EUR',
        retailPrice: price * 2,
        armRegionName: region,
        armSkuName: sku,
        productName: `Virtual Machines ${sku.split('_')[1]} Series Windows`,
        skuName: sku.replace('Standard_', ''),
        unitOfMeasure: '1 Hour',
        type: 'Consumption',
      },
      {
        currencyCode: 'EUR',
        retailPrice: price / 10,
        armRegionName: region,
        armSkuName: sku,
        productName: `Virtual Machines ${sku.split('_')[1]} Series`,
        skuName: `${sku.replace('Standard_', '')} Spot`,
        unitOfMeasure: '1 Hour',
        type: 'Consumption',
      },
    ]);
    return {
      status: 200,
      body: { BillingCurrency: 'EUR', Items: items, NextPageLink: null, Count: items.length },
    };
  }

  private resourceReply(
    req: FakeRequest,
    type: string,
    name: string,
    action: string | undefined,
  ): FakeReply {
    const key = this.key(type, name);
    const existing = this.resources.get(key);
    const isVm = type === 'Microsoft.Compute/virtualMachines';
    if (action !== undefined) {
      if (!isVm || !existing) return { status: 404, body: { error: { code: 'ResourceNotFound' } } };
      if (action === 'instanceView' && req.method === 'GET') {
        return {
          status: 200,
          body: {
            statuses: [
              { code: 'ProvisioningState/succeeded' },
              { code: `PowerState/${this.power.get(name) ?? 'running'}` },
            ],
          },
        };
      }
      if ((action === 'start' || action === 'deallocate') && req.method === 'POST') {
        const state = action === 'start' ? 'running' : 'deallocated';
        this.power.set(name, state);
        this.onPower?.(name, state);
        return { status: 202 };
      }
      return { status: 404, body: { error: { code: 'NotFound' } } };
    }
    switch (req.method) {
      case 'GET':
        if (!existing) return { status: 404, body: { error: { code: 'ResourceNotFound' } } };
        return { status: 200, body: this.view(existing) };
      case 'PUT': {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(req.body) as Record<string, unknown>;
        } catch {
          return { status: 400, body: { error: { code: 'InvalidRequestContent' } } };
        }
        const r: Resource = { type, name, body, polls: existing ? 0 : this.provisionPolls };
        this.resources.set(key, r);
        if (isVm && !existing) {
          this.power.set(name, 'running');
          const disk = `${name}-disk`;
          this.resources.set(this.key('Microsoft.Compute/disks', disk), {
            type: 'Microsoft.Compute/disks',
            name: disk,
            body: {},
            polls: 0,
          });
        }
        return { status: existing ? 200 : 201, body: this.view(r) };
      }
      case 'DELETE':
        if (!existing) return { status: 204 };
        this.resources.delete(key);
        if (isVm) this.power.delete(name);
        return { status: 202 };
      default:
        return { status: 405 };
    }
  }

  private view(r: Resource): unknown {
    let state = 'Succeeded';
    if (r.polls > 0) {
      r.polls -= 1;
      state = 'Creating';
    }
    const props = (r.body.properties as Record<string, unknown> | undefined) ?? {};
    const extra: Record<string, unknown> =
      r.type === 'Microsoft.Network/publicIPAddresses' ? { ipAddress: '203.0.113.7' } : {};
    return {
      id: `/subscriptions/${this.subscription}/resourceGroups/${this.group}/providers/${r.type}/${r.name}`,
      name: r.name,
      ...r.body,
      properties: { ...props, ...extra, provisioningState: state },
    };
  }
}

function flatHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}
