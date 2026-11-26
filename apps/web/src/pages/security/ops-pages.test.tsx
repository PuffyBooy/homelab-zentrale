import { MODULE_DEFAULTS } from '@hz/shared';
import type {
  DiscordBotState,
  Fail2banServer,
  LogSearchResponse,
  VulnScanResult,
  VulnScanState,
} from '@hz/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogHit, LogSearchResults } from '../logsearch/LogSearchPage.js';
import { BindingRow, DiscordBotBody } from '../settings/DiscordBotTile.js';
import { VoiceGameRow, VoiceTile } from '../settings/VoiceTile.js';
import { voiceKey } from '../../lib/ops.js';
import { modulesKey } from '../../lib/modules.js';
import { ModulesTile } from '../settings/ModulesTile.js';
import { BannedIpRow, Fail2banTile, UnbanDialog } from './Fail2banSection.js';
import { runErrorText, VulnRow, VulnscanTile } from './VulnscanSection.js';
import { ApiError } from '../../lib/api.js';

function html(el: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  ).replace(/<!-- -->/g, '');
}

afterEach(() => vi.unstubAllGlobals());

const noop = (): void => undefined;
const TS = '2026-11-26T22:04:00.000Z';

/** Buttons with an aria-label and onClick in an element tree (no DOM needed). */
function clickables(node: ReactNode): { label: string; onClick: () => void }[] {
  const out: { label: string; onClick: () => void }[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    const p = n.props as Record<string, unknown>;
    if (typeof p.onClick === 'function' && typeof p['aria-label'] === 'string') {
      out.push({ label: p['aria-label'], onClick: p.onClick as () => void });
    }
    walk(p.children as ReactNode);
  };
  walk(node);
  return out;
}

// ---- Log-Suche ------------------------------------------------------------------

const request = {
  query: 'onerror',
  caseSensitive: false,
  sinceMinutes: 60,
  maxMatches: 200,
};

function result(over: Partial<LogSearchResponse> = {}): LogSearchResponse {
  return {
    hits: [],
    servers: [
      {
        serverId: 'srv-000001',
        name: 'heimserver',
        state: 'ok',
        scannedContainers: 12,
        truncated: false,
      },
    ],
    tookMs: 1240,
    ...over,
  };
}

describe('Log-Suche', () => {
  it('keeps markup in a log line as text and marks the match', () => {
    const out = html(
      <LogHit
        hit={{
          serverId: 'srv-000001',
          serverName: 'heimserver',
          containerId: 'abc123def456',
          containerName: 'nginx',
          ts: TS,
          stream: 'stderr',
          text: 'GET /<img src=x onerror=alert(1)> 404',
        }}
        query={request.query}
        caseSensitive={false}
      />,
    );
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x <mark>onerror</mark>=alert(1)&gt; 404');
    expect(out).toContain('>stderr<');
    expect(out).toContain('>nginx<');
    expect(out).toContain('>heimserver<');
  });

  it('shows the state of every server and the "gekürzt" hint', () => {
    const out = html(
      <LogSearchResults
        request={request}
        result={result({
          servers: [
            {
              serverId: 'srv-000001',
              name: 'heimserver',
              state: 'ok',
              scannedContainers: 12,
              truncated: true,
            },
            {
              serverId: 'srv-000002',
              name: 'oracle-a1',
              state: 'offline',
              scannedContainers: 0,
              truncated: false,
            },
            {
              serverId: 'srv-000003',
              name: 'pi',
              state: 'unsupported',
              scannedContainers: 0,
              truncated: false,
            },
            {
              serverId: 'srv-000004',
              name: 'vps-2',
              state: 'failed',
              scannedContainers: 0,
              truncated: false,
            },
            {
              serverId: 'srv-000005',
              name: 'nas',
              state: 'no_containers',
              scannedContainers: 0,
              truncated: false,
            },
          ],
        })}
      />,
    );
    expect(out).toContain('12 Container durchsucht');
    expect(out).toContain('>gekürzt<');
    expect(out).toContain('Ergebnis gekürzt.');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('>offline<');
    expect(out).toContain('>Agent zu alt<');
    expect(out).toContain('>Fehler<');
    expect(out).toContain('>keine Container<');
    expect(out).toContain('1,2 s');
  });

  it('says so when nothing matched', () => {
    const out = html(<LogSearchResults request={request} result={result()} />);
    expect(out).toContain('Keine Treffer für „onerror“.');
    expect(out).not.toContain('Ergebnis gekürzt.');
  });
});

// ---- Schwachstellen -------------------------------------------------------------

function vuln(over: Partial<VulnScanResult['scan']> = {}, name = 'nginx'): VulnScanResult {
  return {
    serverId: 'srv-000001',
    serverName: 'heimserver',
    containerName: name,
    scan: {
      image: 'nginx:1.27',
      digest: null,
      scannable: true,
      reason: null,
      counts: { critical: 0, high: 0 },
      vulns: [],
      scannedAt: TS,
      ...over,
    },
  };
}

function vulnState(over: Partial<VulnScanState> = {}): VulnScanState {
  return {
    settings: { time: '03:30', alertFrom: 'critical' },
    running: false,
    progress: null,
    lastRunAt: TS,
    nextRunAt: '2026-11-27T02:30:00.000Z',
    skippedServers: [],
    results: [],
    ...over,
  };
}

describe('Schwachstellen', () => {
  it('lists containers with status shape and text', () => {
    const out = html(
      <VulnscanTile
        state={vulnState({
          results: [
            vuln({ counts: { critical: 2, high: 5 } }, 'nginx'),
            vuln({ counts: { critical: 0, high: 1 } }, 'redis'),
            vuln({}, 'postgres'),
            vuln({ scannable: false, reason: 'local_image' }, 'my-app'),
            vuln({ scannable: false, reason: 'scan_failed' }, 'grafana'),
          ],
          skippedServers: [{ serverId: 'srv-000002', name: 'pi' }],
        })}
        running={false}
        onRun={noop}
        runBusy={false}
        runError={null}
      />,
    );
    expect(out).toContain('2 CRIT · 5 HIGH');
    expect(out).toContain('hz-status-crit');
    expect(out).toContain('hz-status-warn');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('nicht prüfbar (lokal gebaut)');
    expect(out).toContain('Scan fehlgeschlagen');
    expect(out).toContain('Nicht geprüft: pi.');
    expect(out).toContain('>Jetzt prüfen<');
  });

  it('shows the progress while a scan runs', () => {
    const out = html(
      <VulnscanTile
        state={vulnState({ running: true, progress: { done: 3, total: 12 } })}
        running
        onRun={noop}
        runBusy={false}
        runError={null}
      />,
    );
    expect(out).toContain('3 von 12 Containern');
    expect(out).toContain('Prüft …');
    expect(out).toMatch(/<button[^>]*disabled/);
  });

  it('expands to the CVE list with plain-text ids', () => {
    const r = vuln({
      counts: { critical: 1, high: 0 },
      vulns: [
        {
          id: 'CVE-2026-1234',
          pkg: 'openssl',
          installed: '3.0.1',
          fixed: '3.0.9',
          severity: 'CRITICAL',
          title: 'Buffer overflow <script>x</script>',
        },
      ],
    });
    expect(html(<VulnRow result={r} />)).not.toContain('CVE-2026-1234');
    const out = html(<VulnRow result={r} initialOpen />);
    expect(out).toContain('>CVE-2026-1234<');
    expect(out).toContain('>openssl<');
    expect(out).toContain('>3.0.9<');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<a ');
    expect(out).toContain('aria-expanded="true"');
  });

  it('explains 409 and 429 of "Jetzt prüfen"', () => {
    expect(runErrorText(new ApiError(409, 'busy'))).toBe('Prüfung läuft schon.');
    expect(runErrorText(new ApiError(409, 'conflict'))).toBe('Prüfung läuft schon.');
    expect(runErrorText(new ApiError(429, 'rate_limited', 420))).toBe(
      'Höchstens eine Prüfung alle 10 Min. Wieder möglich in 7 Min.',
    );
  });
});

// ---- Fail2ban -------------------------------------------------------------------

function f2b(over: Partial<Fail2banServer> = {}): Fail2banServer {
  return {
    serverId: 'srv-000001',
    name: 'heimserver',
    state: 'ok',
    jails: [
      {
        name: 'sshd',
        currentlyFailed: 4,
        totalFailed: 380,
        currentlyBanned: 2,
        totalBanned: 41,
        bannedIps: ['203.0.113.7', '2001:db8::1'],
      },
    ],
    fetchedAt: TS,
    ...over,
  };
}

describe('Fail2ban', () => {
  it('shows jails with counts and banned IPs', () => {
    const out = html(<Fail2banTile server={f2b()} onUnban={noop} />);
    expect(out).toContain('>sshd<');
    expect(out).toContain('2 gesperrt (gesamt 41) · 4 Fehlversuche (gesamt 380)');
    expect(out).toContain('>203.0.113.7<');
    expect(out).toContain('aria-label="203.0.113.7 in sshd entsperren"');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).not.toContain('<dialog');
  });

  it('shows "nicht installiert" and offline', () => {
    const none = html(
      <Fail2banTile server={f2b({ state: 'not_installed', jails: [] })} onUnban={noop} />,
    );
    expect(none).toContain('nicht installiert');
    expect(none).toContain('hz-status-off');
    const off = html(<Fail2banTile server={f2b({ state: 'offline', jails: [] })} onUnban={noop} />);
    expect(off).toContain('Server offline.');
    expect(off).toContain('hz-status-crit');
  });

  it('"Entsperren" only asks; the request goes out from the dialog', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const onUnban = vi.fn();
    const row = BannedIpRow({ ip: '203.0.113.7', jail: 'sshd', onUnban });
    const button = clickables(row).find((c) => c.label === '203.0.113.7 in sshd entsperren');
    expect(button).toBeDefined();
    button?.onClick();
    expect(onUnban).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const dialog = html(
      <UnbanDialog
        target={{
          serverId: 'srv-000001',
          serverName: 'heimserver',
          jail: 'sshd',
          ip: '203.0.113.7',
        }}
        onClose={noop}
      />,
    );
    expect(dialog).toContain('<dialog');
    expect(dialog).toContain('203.0.113.7 entsperren?');
    expect(dialog).toContain('>Abbrechen<');
    expect(dialog).toContain('hz-btn-danger');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---- Discord-Bot ----------------------------------------------------------------

function bot(over: Partial<DiscordBotState> = {}): DiscordBotState {
  return {
    tokenSet: true,
    applicationId: '123456789012345678',
    guildId: '223456789012345678',
    status: 'online',
    statusText: 'Verbunden als Zentrale#1234',
    bindings: [
      {
        shareId: 'share-0001',
        gameId: 'game-0001',
        gameName: 'minecraft',
        person: 'Lukas',
        discordUserId: null,
        shareState: 'active',
      },
    ],
    ...over,
  };
}

describe('Discord-Bot', () => {
  it('never shows the token, only "gespeichert"', () => {
    const out = html(<DiscordBotBody state={bot()} />);
    const input = /<input[^>]*type="password"[^>]*>/.exec(out)?.[0] ?? '';
    expect(input).toContain('value=""');
    expect(input).toContain('placeholder="gespeichert"');
    expect(out).toContain('data-testid="discord-token-state">gespeichert<');
    expect(out).toContain('>Token löschen<');
    expect(out).toContain('hz-status-ok');
    expect(out).toContain('Verbunden als Zentrale#1234');
  });

  it('builds the invite link and lists the commands', () => {
    const out = html(<DiscordBotBody state={bot()} />);
    expect(out).toContain(
      'https://discord.com/oauth2/authorize?client_id=123456789012345678&amp;scope=bot%20applications.commands',
    );
    for (const c of ['/status', '/start spiel', '/stop spiel', '/restart spiel']) {
      expect(out).toContain(`>${c}<`);
    }
  });

  it('without token: no delete button, no invite link without application id', () => {
    const out = html(
      <DiscordBotBody
        state={bot({
          tokenSet: false,
          applicationId: null,
          status: 'unconfigured',
          statusText: 'Nicht eingerichtet',
        })}
      />,
    );
    expect(out).toContain('kein Token');
    expect(out).not.toContain('Token löschen');
    expect(out).not.toContain('oauth2/authorize');
    expect(out).toContain('hz-status-off');
  });

  it('binding row: input for the Discord user id with the hint', () => {
    const b = bot().bindings[0];
    if (!b) throw new Error('fixture');
    const out = html(<BindingRow binding={b} />);
    expect(out).toContain('>Lukas<');
    expect(out).toContain('minecraft · Link aktiv');
    expect(out).toContain('nicht gebunden');
    expect(out).toContain(
      'Rechtsklick auf den Namen → Benutzer-ID kopieren, Entwicklermodus nötig.',
    );
    const revoked = html(
      <BindingRow binding={{ ...b, shareState: 'revoked', discordUserId: '333333333333333333' }} />,
    );
    expect(revoked).toContain('Link widerrufen');
    expect(revoked).toContain('wirkt nicht');
    expect(revoked).toContain('value="333333333333333333"');
  });
});

// ---- Sprachsteuerung ------------------------------------------------------------

describe('Sprachsteuerung', () => {
  it('shows entities, the stop switch and the last trigger', () => {
    const out = html(
      <VoiceGameRow
        game={{
          gameId: 'game-0001',
          gameName: 'minecraft',
          switchEntity: 'input_boolean.minecraft',
          statusEntity: null,
          allowStop: false,
          lastTriggerAt: null,
        }}
      />,
    );
    expect(out).toContain('value="input_boolean.minecraft"');
    expect(out).toContain('placeholder="input_text.minecraft_status"');
    expect(out).toContain('aria-label="Alexa darf stoppen"');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('zuletzt ausgelöst noch nie');
  });
});

describe('Sprachsteuerung ohne Home Assistant', () => {
  it('points to the HA settings', () => {
    const client = new QueryClient();
    client.setQueryData(voiceKey, { haReady: false, games: [] });
    const out = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <VoiceTile />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(out).toContain('Home Assistant ist nicht verbunden.');
    expect(out).toContain('href="/settings#ha"');
    expect(out).toContain('Noch kein Gameserver angelegt.');
    expect(out).toContain('nur über Tailscale');
  });
});

describe('Einstellungen → Module', () => {
  it('lists the five operations modules, all off', () => {
    const client = new QueryClient();
    client.setQueryData(modulesKey, { ...MODULE_DEFAULTS });
    const out = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ModulesTile />
      </QueryClientProvider>,
    );
    for (const [label, hint] of [
      ['Log-Suche', 'Logs aller Container auf allen Servern durchsuchen'],
      ['Schwachstellen-Scan', 'Nachts die Images laufender Container mit Trivy prüfen'],
      ['Fail2ban', 'Gesperrte IPs pro Server sehen und entsperren'],
      ['Discord-Bot', 'Freunde starten Gameserver mit /start, mit den Rechten ihres Benutzerlinks'],
      ['Sprachsteuerung', 'Echo Show und Alexa über Home Assistant'],
    ] as const) {
      expect(out).toContain(`aria-checked="false" aria-label="${label}"`);
      expect(out).toContain(`aus · ${hint}`);
    }
  });
});
