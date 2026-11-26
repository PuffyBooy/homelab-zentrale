import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Alert,
  Badge,
  Button,
  CommitRow,
  GameServer,
  GameTemplates,
  Icon,
  iconNames,
  Metric,
  NavRail,
  RepoRow,
  ServerList,
  ServerSwitch,
  ServiceRow,
  ShareLink,
  Sparkline,
  StatusDot,
  Terminal,
  Tile,
  Toggle,
  UsageBar,
  WebCheckRow,
} from '@hz/ui';
import type { GameTemplate, NavItem, ServerEntry, ServerInfo, Status } from '@hz/ui';

/**
 * Dev-only gallery data. Every card mirrors design/reference/previews/<name>.html with the same
 * data and the same DOM. Differences: inline colour styles of the preview wrappers are dropped;
 * wrappers that only painted a surface use `hz-tile hz-tile-flush` and carry `data-wrap`.
 */
export interface GalleryCard {
  name: string;
  /** Class of `#root` in the preview HTML. */
  rootClass: string;
  Demo: () => ReactElement;
}

const SERVERS: ServerInfo[] = [
  {
    id: 'home',
    name: 'heimserver',
    where: 'Zuhause',
    ip: '192.168.1.20',
    status: 'ok',
    cpu: 23,
    ram: 48,
    disk: 81,
    uptime: '41d',
  },
  {
    id: 'oci',
    name: 'oracle-a1',
    where: 'Frankfurt',
    ip: '130.61.x.x',
    status: 'warn',
    cpu: 64,
    ram: 92,
    disk: 37,
    uptime: '12d',
  },
  {
    id: 'pi',
    name: 'pi',
    where: 'Studio',
    ip: '192.168.1.42',
    status: 'ok',
    cpu: 8,
    ram: 31,
    disk: 22,
    uptime: '6d',
  },
  {
    id: 'vps',
    name: 'web-vps',
    where: 'Nürnberg',
    status: 'crit',
    note: 'kein Ping seit 23:02 · SSH timeout',
  },
];

function SurvivalServer(): ReactElement {
  return (
    <GameServer
      name="survival"
      game="Minecraft Paper"
      version="1.21.4"
      address="mc.example.org"
      status="ok"
      players={[4, 20]}
      ram={72}
      ramDetail="5,8 / 8 GB"
      tps={19.8}
      online={['Sam', 'Lukas', 'mia_07', 'Tobi']}
      host="oracle-a1"
    />
  );
}

function AlertDemo(): ReactElement {
  return (
    <>
      <Alert
        tone="crit"
        title="example.at ist offline"
        time="23:04"
        action={<Button size="sm">Ansehen</Button>}
      >
        HTTP 503 seit 6 Min. Letzter erfolgreicher Check 22:58.
      </Alert>
      <Alert tone="warn" title="Speicher auf heimserver bei 81 %" time="22:40">
        Docker-Images belegen 64 GB. Aufräumen gibt ca. 40 GB frei.
      </Alert>
      <Alert tone="ok" title="Backup fertig" time="03:00">
        heimserver → oracle-a1, 12,4 GB, 6 Min.
      </Alert>
      <Alert tone="info" title="Neuer Commit in my-app" time="21:12" floating>
        „Lyrics-Sync für Bühne-Stil“ ist bereit zum Deploy.
      </Alert>
    </>
  );
}

function BadgeDemo(): ReactElement {
  return (
    <>
      <Badge>docker</Badge>
      <Badge tone="ok">online</Badge>
      <Badge tone="warn" icon="alert">
        3 Updates
      </Badge>
      <Badge tone="crit">offline</Badge>
      <Badge tone="info">deploy</Badge>
      <Badge tone="accent" icon="check">
        live
      </Badge>
    </>
  );
}

function ButtonDemo(): ReactElement {
  return (
    <>
      <Button variant="primary" icon="refresh">
        Neu deployen
      </Button>
      <Button icon="play">Starten</Button>
      <Button variant="ghost" icon="terminal">
        Logs
      </Button>
      <Button variant="danger" icon="power">
        Neustart
      </Button>
      <Button size="sm" icon="stop" aria-label="Stoppen" />
      <Button disabled>Gesperrt</Button>
    </>
  );
}

function CommitRowDemo(): ReactElement {
  return (
    <div
      className="hz-tile hz-tile-flush"
      data-wrap=""
      style={{ width: '100%', maxWidth: '600px', padding: '4px' }}
    >
      <CommitRow
        message="Lyrics-Sync für Bühne-Stil"
        repo="my-app"
        hash="a3f9c21e"
        time="vor 2 Std"
        live
      />
      <CommitRow
        message="3D-Modelle ohne data:-Links laden"
        repo="novritsch-konfigurator"
        hash="7be0d44a"
        time="vor 5 Std"
        status="busy"
        action={
          <Button size="sm" variant="primary" icon="refresh">
            Deploy
          </Button>
        }
      />
      <CommitRow
        message="Login mit 2FA"
        repo="lernplattform"
        branch="dev"
        hash="11cd0e9f"
        time="gestern"
        status="crit"
        statusLabel="Build fehlgeschlagen"
        action={<Badge tone="crit">CI rot</Badge>}
      />
    </div>
  );
}

const DASHBOARD_NAV: NavItem[] = [
  { id: 'overview', label: 'Übersicht', icon: 'cpu' },
  { id: 'servers', label: 'Server', icon: 'server' },
  { id: 'docker', label: 'Container', icon: 'container' },
  { id: 'games', label: 'Gameserver', icon: 'gamepad' },
  { id: 'git', label: 'GitHub', icon: 'git' },
  { id: 'web', label: 'Websites', icon: 'globe', count: 1 },
  { id: 'home', label: 'Wohnung', icon: 'home' },
  { id: 'alerts', label: 'Meldungen', icon: 'bell', count: 2 },
  { id: 'shell', label: 'Konsole', icon: 'terminal', key: '`' },
];

const DASHBOARD_SWITCH: ServerEntry[] = [
  { id: 'all', name: 'alle' },
  { id: 'home', name: 'heimserver' },
  { id: 'oci', name: 'oracle-a1', status: 'warn' },
  { id: 'pi', name: 'pi' },
  { id: 'vps', name: 'web-vps', status: 'crit' },
];

const PAIR = { display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '16px' } as const;

function DashboardDemo(): ReactElement {
  return (
    <div className="hz-page">
      <NavRail active="overview" items={DASHBOARD_NAV} />
      <main className="hz-page-main">
        <div className="hz-page-top">
          <div>
            <h1 className="hz-page-title">
              <em>2 Probleme</em> · 3 von 4 Servern laufen
            </h1>
            <div className="hz-page-sub">aktualisiert 23:24:08 · nächster Check in 12 s</div>
          </div>
          <ServerSwitch active="all" servers={DASHBOARD_SWITCH} />
        </div>
        <Alert
          tone="crit"
          time="23:02"
          title="web-vps nicht erreichbar"
          action={<Button size="sm">Ansehen</Button>}
        >
          kein Ping, SSH timeout seit 22 Min.
        </Alert>
        <Tile title="Server" icon="server" count="4" flush>
          <ServerList active="home" servers={SERVERS} />
        </Tile>
        <div style={PAIR}>
          <SurvivalServer />
          <Tile title="Websites" icon="globe" count="3" flush>
            <WebCheckRow url="example.at" status="ok" code={200} ms={312} sslDays={61} />
            <WebCheckRow
              url="volontaers-alarm.app"
              status="warn"
              code={200}
              ms={1240}
              sslDays={9}
            />
            <WebCheckRow url="lernen.example.org" status="crit" code={503} ms={null} sslDays={44} />
          </Tile>
        </div>
        <div style={PAIR}>
          <Tile title="GitHub" icon="git" count="PuffyBooy" flush>
            <RepoRow
              repo="my-app"
              commit="a3f9c21 Lyrics-Sync · vor 2 Std"
              ci="ok"
              deployedTo="pi"
            />
            <RepoRow
              repo="novritsch-konfigurator"
              commit="7be0d44 3D ohne data:-Links · vor 5 Std"
              ci="ok"
              deployedTo="heimserver"
              behind={2}
              action={
                <Button size="sm" variant="primary">
                  Deploy
                </Button>
              }
            />
          </Tile>
          <Tile title="Container" icon="container" count="14 · 1 aus" flush>
            <ServiceRow name="homeassistant" host="heimserver · :8123" meta="41d" />
            <ServiceRow
              name="lernplattform"
              host="heimserver · :3000"
              status="crit"
              meta="exit 1"
            />
            <ServiceRow name="uptime-kuma" host="heimserver · :3001" status="off" meta="—" />
          </Tile>
        </div>
      </main>
    </div>
  );
}

function GameServerDemo(): ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', width: '100%' }}>
      <SurvivalServer />
      <GameServer
        name="valheim-freunde"
        game="Valheim"
        address="130.61.x.x:2456"
        status="off"
        players={[0, 10]}
        ram={0}
        ramDetail="0 / 4 GB"
        tps={null}
        host="heimserver"
      />
    </div>
  );
}

const TEMPLATES: GameTemplate[] = [
  {
    id: 'mc-paper',
    name: 'Minecraft Java',
    image: 'itzg/minecraft-server · Paper',
    ram: '4–8 GB',
    port: 25565,
  },
  {
    id: 'mc-bedrock',
    name: 'Minecraft Bedrock',
    image: 'itzg/minecraft-bedrock-server',
    ram: '2 GB',
    port: 19132,
  },
  { id: 'valheim', name: 'Valheim', image: 'lloesche/valheim-server', ram: '4 GB', port: 2456 },
  {
    id: 'terraria',
    name: 'Terraria',
    image: 'ryshe/terraria · tModLoader',
    ram: '2 GB',
    port: 7777,
  },
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    image: 'joedwards32/cs2',
    ram: '8 GB',
    port: 27015,
    fits: false,
  },
  {
    id: 'palworld',
    name: 'Palworld',
    image: 'thijsvanloef/palworld-server',
    ram: '16 GB',
    port: 8211,
    fits: false,
  },
];

function GameTemplatesDemo(): ReactElement {
  const [selected, setSelected] = useState('mc-paper');
  return <GameTemplates selected={selected} onPick={setSelected} templates={TEMPLATES} />;
}

function IconDemo(): ReactElement {
  return (
    <>
      {iconNames.map((n) => (
        <span key={n} title={n} style={{ padding: '6px' }}>
          <Icon name={n} size={20} />
        </span>
      ))}
    </>
  );
}

function MetricDemo(): ReactElement {
  return (
    <>
      <Metric label="RAM" value="7,8" unit="GB" hint="von 16 GB" />
      <Metric
        label="Strom Server"
        value="38"
        unit="W"
        delta="+6 W"
        deltaTone="warn"
        hint="≈ 8,20 € / Monat"
      />
      <Metric label="Uptime" value="41" unit="Tage" hint="seit 15.10." />
    </>
  );
}

const RAIL_NAV: NavItem[] = [
  { id: 'overview', label: 'Übersicht', icon: 'cpu' },
  { id: 'servers', label: 'Server', icon: 'server' },
  { id: 'docker', label: 'Container', icon: 'container' },
  { id: 'git', label: 'Git & Deploys', icon: 'git' },
  { id: 'web', label: 'Websites', icon: 'globe', count: 1 },
  { id: 'home', label: 'Wohnung', icon: 'home' },
  { id: 'alerts', label: 'Meldungen', icon: 'bell', count: 3 },
  { id: 'shell', label: 'Konsole', icon: 'terminal' },
];

function NavRailDemo(): ReactElement {
  return <NavRail active="overview" items={RAIL_NAV} />;
}

function RepoRowDemo(): ReactElement {
  return (
    <div className="hz-tile hz-tile-flush" style={{ width: '100%' }}>
      <RepoRow
        repo="PuffyBooy/my-app"
        commit="a3f9c21 Lyrics-Sync für Bühne-Stil · vor 2 Std"
        ci="ok"
        deployedTo="pi"
      />
      <RepoRow
        repo="PuffyBooy/novritsch-konfigurator"
        commit="7be0d44 3D-Modelle ohne data:-Links · vor 5 Std"
        ci="busy"
        deployedTo="heimserver"
        behind={2}
        action={
          <Button size="sm" variant="primary" icon="refresh">
            Deploy
          </Button>
        }
      />
      <RepoRow
        repo="PuffyBooy/lernplattform"
        branch="dev"
        commit="11cd0e9 Login mit 2FA · gestern"
        ci="crit"
        deployedTo={null}
      />
    </div>
  );
}

function ServerListDemo(): ReactElement {
  const [active, setActive] = useState('home');
  return (
    <div className="hz-tile hz-tile-flush" style={{ width: '100%' }}>
      <ServerList active={active} onSelect={setActive} servers={SERVERS} />
    </div>
  );
}

const SWITCH: ServerEntry[] = [
  { id: 'all', name: 'Alle', icon: 'cpu' },
  { id: 'home', name: 'heimserver', where: 'Zuhause' },
  { id: 'oci', name: 'oracle-a1', icon: 'cloud', where: 'Frankfurt', status: 'warn' },
  { id: 'pi', name: 'pi', where: 'Studio', status: 'off' },
];

function ServerSwitchDemo(): ReactElement {
  const [active, setActive] = useState('home');
  return <ServerSwitch active={active} onChange={setActive} servers={SWITCH} />;
}

function ServiceRowDemo(): ReactElement {
  return (
    <div
      className="hz-tile hz-tile-flush"
      data-wrap=""
      style={{ width: '100%', maxWidth: '560px', padding: '4px' }}
    >
      <ServiceRow
        name="homeassistant"
        icon="home"
        host="heimserver · :8123"
        meta="41 T"
        actions={<Button size="sm" variant="ghost" icon="terminal" aria-label="Logs" />}
      />
      <ServiceRow
        name="minecraft-paper"
        icon="container"
        host="oracle-a1 · :25565"
        status="warn"
        meta="RAM 92 %"
        actions={<Button size="sm" variant="ghost" icon="refresh" aria-label="Neu starten" />}
      />
      <ServiceRow
        name="example.at"
        icon="globe"
        host="extern · https"
        status="crit"
        meta="503"
        actions={<Button size="sm" variant="ghost" icon="refresh" aria-label="Erneut prüfen" />}
      />
      <ServiceRow
        name="uptime-kuma"
        icon="container"
        host="heimserver · :3001"
        status="off"
        meta="—"
        actions={<Button size="sm" variant="ghost" icon="play" aria-label="Starten" />}
      />
    </div>
  );
}

function ShareLinkDemo(): ReactElement {
  return (
    <div style={{ width: '100%', maxWidth: '520px' }}>
      <ShareLink
        server="survival"
        user="Lukas"
        url="https://zentrale.example.org/g/k7Qm2xPa9"
        expires="läuft ab in 14 Tagen"
        lastUsed="gestern 20:41"
        perms={[
          { id: 'start', label: 'Starten/Stoppen', on: true },
          { id: 'restart', label: 'Neustart', on: true },
          { id: 'console', label: 'Konsole', on: false },
          { id: 'wl', label: 'Whitelist', on: true },
          { id: 'files', label: 'Dateien', on: false },
        ]}
      />
    </div>
  );
}

function SparklineDemo(): ReactElement {
  return (
    <>
      <Sparkline data={[12, 18, 15, 22, 30, 26, 23, 28, 24, 21, 19, 23]} />
      <Sparkline tone="ok" data={[40, 42, 41, 44, 47, 45, 49, 52, 50, 53]} />
      <Sparkline tone="info" data={[3, 3, 4, 9, 4, 3, 3, 2, 8, 3]} />
      <Sparkline tone="muted" data={[5, 6, 5, 7, 6, 6, 5, 6]} />
    </>
  );
}

const ALL_STATUS: Status[] = ['ok', 'warn', 'crit', 'off', 'info', 'busy'];

function StatusDotDemo(): ReactElement {
  return (
    <>
      {ALL_STATUS.map((s) => (
        <StatusDot key={s} status={s} />
      ))}
    </>
  );
}

function TerminalDemo(): ReactElement {
  return (
    <div style={{ width: '100%' }}>
      <Terminal
        title="docker logs minecraft-paper"
        host="oracle-a1"
        lines={[
          { kind: 'cmd', text: 'docker compose pull && docker compose up -d' },
          { kind: 'dim', text: '[+] Pulling 1/1  ✔ paper  Pulled  4.2s' },
          { kind: 'ok', text: '[+] Running 1/1  ✔ Container minecraft-paper  Started' },
          {
            kind: 'warn',
            text: "[WARN] Can't keep up! Is the server overloaded? Running 2140ms behind",
          },
          { text: '[INFO] Sam joined the game' },
          { kind: 'err', text: '[ERROR] Could not pass event PlayerMoveEvent to WorldGuard' },
        ]}
      />
    </div>
  );
}

function TileDemo(): ReactElement {
  return (
    <div className="hz-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <Tile
        title="Heimserver"
        icon="server"
        status="ok"
        footer={
          <>
            <span>ubuntu-24.04 · 192.168.1.20</span>
            <span>vor 4 s</span>
          </>
        }
      >
        <Metric
          label="CPU-Last"
          value="23"
          unit="%"
          delta="−4 %"
          deltaTone="ok"
          hint="letzte Stunde"
        />
      </Tile>
      <Tile
        title="Oracle Cloud"
        icon="cloud"
        status="crit"
        statusLabel="Nicht erreichbar"
        actions={<Button size="sm" variant="ghost" icon="refresh" aria-label="Erneut prüfen" />}
      >
        <div>Letzter Kontakt vor 12 Min. Ping und SSH schlagen fehl.</div>
      </Tile>
    </div>
  );
}

function ToggleDemo(): ReactElement {
  const [light, setLight] = useState(true);
  const [plug, setPlug] = useState(false);
  return (
    <div style={{ width: '100%', maxWidth: '380px' }}>
      <Toggle label="Licht Wohnzimmer" icon="plug" checked={light} onChange={setLight} />
      <Toggle
        label="Server-Steckdose"
        hint="38 W · aus nur mit Bestätigung"
        icon="power"
        checked={plug}
        onChange={setPlug}
      />
      <Toggle label="Türöffner" hint="offline" icon="door" disabled />
    </div>
  );
}

function UsageBarDemo(): ReactElement {
  return (
    <div style={{ display: 'grid', gap: '16px', width: '100%', maxWidth: '420px' }}>
      <UsageBar label="CPU" value={23} />
      <UsageBar label="Speicher /" value={81} detail="389 / 480 GB" />
      <UsageBar label="OCPU" value={96} detail="3,85 / 4" />
    </div>
  );
}

function WebCheckRowDemo(): ReactElement {
  return (
    <div className="hz-tile hz-tile-flush" style={{ width: '100%' }}>
      <WebCheckRow
        url="example.at"
        host="WordPress · World4You"
        status="ok"
        code={200}
        ms={312}
        sslDays={61}
      />
      <WebCheckRow
        url="volontaers-alarm.app"
        host="heimserver · caddy"
        status="warn"
        code={200}
        ms={1240}
        sslDays={9}
      />
      <WebCheckRow
        url="lernen.example.org"
        host="heimserver · docker"
        status="crit"
        code={503}
        ms={null}
        sslDays={44}
        actions={<Button size="sm" variant="ghost" icon="terminal" aria-label="Logs" />}
      />
      <WebCheckRow
        url="mc.example.org"
        host="oracle-a1 · tcp 25565"
        status="ok"
        code="TCP"
        ms={28}
      />
    </div>
  );
}

/** One entry per design/reference/previews/*.html (Cover.html is brand art, not a component). */
export const galleryCards: GalleryCard[] = [
  { name: 'Dashboard', rootClass: '', Demo: DashboardDemo },
  { name: 'Alert', rootClass: 'hz-demo-col', Demo: AlertDemo },
  { name: 'Badge', rootClass: 'hz-demo', Demo: BadgeDemo },
  { name: 'Button', rootClass: 'hz-demo', Demo: ButtonDemo },
  { name: 'CommitRow', rootClass: 'hz-demo-col', Demo: CommitRowDemo },
  { name: 'GameServer', rootClass: 'hz-demo-col', Demo: GameServerDemo },
  { name: 'GameTemplates', rootClass: 'hz-demo-col', Demo: GameTemplatesDemo },
  { name: 'Icon', rootClass: 'hz-demo', Demo: IconDemo },
  { name: 'Metric', rootClass: 'hz-demo', Demo: MetricDemo },
  { name: 'NavRail', rootClass: '', Demo: NavRailDemo },
  { name: 'RepoRow', rootClass: 'hz-demo-col', Demo: RepoRowDemo },
  { name: 'ServerList', rootClass: 'hz-demo-col', Demo: ServerListDemo },
  { name: 'ServerSwitch', rootClass: 'hz-demo', Demo: ServerSwitchDemo },
  { name: 'ServiceRow', rootClass: 'hz-demo-col', Demo: ServiceRowDemo },
  { name: 'ShareLink', rootClass: 'hz-demo-col', Demo: ShareLinkDemo },
  { name: 'Sparkline', rootClass: 'hz-demo', Demo: SparklineDemo },
  { name: 'StatusDot', rootClass: 'hz-demo', Demo: StatusDotDemo },
  { name: 'Terminal', rootClass: 'hz-demo-col', Demo: TerminalDemo },
  { name: 'Tile', rootClass: 'hz-demo-col', Demo: TileDemo },
  { name: 'Toggle', rootClass: 'hz-demo-col', Demo: ToggleDemo },
  { name: 'UsageBar', rootClass: 'hz-demo-col', Demo: UsageBarDemo },
  { name: 'WebCheckRow', rootClass: 'hz-demo-col', Demo: WebCheckRowDemo },
];
