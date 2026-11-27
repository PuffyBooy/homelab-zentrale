import { useState, type ReactElement } from 'react';
import { FormError } from '../../components/FormError.js';
import { useServers } from '../../lib/data.js';
import { domainsSentence, useDomains } from '../../lib/domains.js';
import { errorText } from '../../lib/errors.js';
import { useSpeedtest, type SpeedtestDays } from '../../lib/speedtest.js';
import { useModules } from '../../lib/useModules.js';
import { useNow } from '../../lib/useNow.js';
import { ModuleOff } from '../../routes/ModuleGate.js';
import { CertificatesTile } from './CertTiles.js';
import { ProvidersTile, RecordsTile } from './DnsTiles.js';
import {
  SpeedtestSettingsTile,
  SpeedtestSummaryTile,
  SpeedtestTableTile,
} from './SpeedtestTiles.js';

/**
 * /internet "Internet" (M20): Speedtest-Verlauf (module speedtest) and Domains,
 * DNS-Einträge, Zertifikate (module domains). The page shows while one of them is on.
 */
export function InternetPage(): ReactElement {
  const modules = useModules();
  const now = useNow(30_000);
  const domains = useDomains(modules.domains);
  const speed = modules.speedtest ? (
    <SpeedtestSection key="speed" now={now} />
  ) : (
    <ModuleOff key="speed" module="speedtest" title="Speedtest" />
  );
  const dns = modules.domains ? (
    <DomainsSection key="dns" now={now} />
  ) : (
    <ModuleOff key="dns" module="domains" title="Domains und Zertifikate" />
  );
  // Problems first: DNS or certificate trouble goes above the speed test.
  const dnsFirst = modules.domains && !!domainsSentence(domains.data, now).em;
  return <div className="hz-grid app-grid">{dnsFirst ? [dns, speed] : [speed, dns]}</div>;
}

function SpeedtestSection({ now }: { now: Date }): ReactElement | null {
  const [days, setDays] = useState<SpeedtestDays>(7);
  const q = useSpeedtest(days);
  const servers = useServers();
  if (q.error && !q.data) return <FormError title={errorText(q.error)} />;
  if (!q.data) return null;
  return (
    <>
      <SpeedtestSummaryTile data={q.data} days={days} onDays={setDays} now={now} />
      <SpeedtestSettingsTile data={q.data} servers={servers.data ?? []} />
      <SpeedtestTableTile data={q.data} now={now} />
    </>
  );
}

function DomainsSection({ now }: { now: Date }): ReactElement | null {
  const q = useDomains();
  const servers = useServers();
  if (q.error && !q.data) return <FormError title={errorText(q.error)} />;
  if (!q.data) return null;
  const list = servers.data ?? [];
  return (
    <>
      <ProvidersTile data={q.data} now={now} />
      <RecordsTile data={q.data} servers={list} now={now} />
      <CertificatesTile data={q.data} servers={list} now={now} />
    </>
  );
}
