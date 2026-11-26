import type { DnsFilterStatus } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Button, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { NotConfigured } from '../../components/NotConfigured.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { isNetworkOn } from '../../lib/modules.js';
import {
  dnsFilterStatusKey,
  internetState,
  rebootFritzBox,
  setDnsBlocking,
  useNetworkView,
  type DeviceFilter,
  type PauseMinutes,
} from '../../lib/network.js';
import { useModules } from '../../lib/useModules.js';
import { useNow } from '../../lib/useNow.js';
import { DevicesTile, DnsFilterTile, InternetTile } from './NetworkTiles.js';

const shown = (err: unknown): string | null =>
  err && !isApiError(err, 'step_up_required') ? errorText(err) : null;

/**
 * /network (SPEC 16): FRITZ!Box (Internet, Geräte im Netz) and the DNS filter. Only the
 * tiles of switched-on modules; polled every 15 s. Problems first: a tile with a down
 * internet line or an unreachable system moves to the top left.
 */
export function NetworkPage(): ReactElement {
  const modules = useModules();
  const qc = useQueryClient();
  const net = useNetworkView(modules);
  const { fritz, dns, fritzReady, dnsReady } = net;
  const now = useNow(30_000);
  const [filter, setFilter] = useState<DeviceFilter>('active');
  const [rebootOpen, setRebootOpen] = useState(false);

  const reboot = useMutation({
    mutationFn: rebootFritzBox,
    onSuccess: () => setRebootOpen(false),
  });
  const blocking = useMutation({
    mutationFn: (m: PauseMinutes | null) => setDnsBlocking(m),
    onSuccess: (next) => qc.setQueryData<DnsFilterStatus>(dnsFilterStatusKey, next),
  });

  if (!isNetworkOn(modules)) return <NetworkOff />;

  const f = net.fritzData;
  const d = net.dnsData;
  const internetDown = f ? internetState(f) === 'down' || !!f.error : false;
  const dnsBad = d ? !!d.error : false;

  const internetTile = f ? (
    <InternetTile
      key="internet"
      fritz={f}
      now={now}
      rebootDone={reboot.isSuccess}
      onReboot={() => {
        reboot.reset();
        setRebootOpen(true);
      }}
    />
  ) : null;
  const dnsTile = d ? (
    <DnsFilterTile
      key="dns"
      dns={d}
      now={now}
      busy={blocking.isPending}
      error={shown(blocking.error)}
      onBlocking={(m) => blocking.mutate(m)}
    />
  ) : null;
  const top = dnsBad && !internetDown ? [dnsTile, internetTile] : [internetTile, dnsTile];

  return (
    <>
      <div className="hz-grid app-grid">
        {fritzReady && fritz.isError && !fritz.data ? (
          <Tile title="Internet" icon="globe" span={2}>
            <FormError title={errorText(fritz.error)} />
          </Tile>
        ) : null}
        {dnsReady && dns.isError && !dns.data ? (
          <Tile title="DNS-Filter" icon="lock" span={2}>
            <FormError title={errorText(dns.error)} />
          </Tile>
        ) : null}
        {top}
        {modules.fritzbox && net.fritzSettings.configured === false ? (
          <NotConfigured
            integration="fritzbox"
            title="Internet"
            icon="globe"
            span={2}
            text="FRITZ!Box ist noch nicht eingerichtet. Trag Adresse, Benutzer und Passwort ein, dann siehst du hier Internet-Status und Geräte im Netz."
          />
        ) : null}
        {modules.dnsfilter && net.dnsSettings.configured === false ? (
          <NotConfigured
            integration="dnsfilter"
            title="DNS-Filter"
            icon="lock"
            span={2}
            text="DNS-Filter ist noch nicht eingerichtet. Trag Pi-hole oder AdGuard Home mit Adresse und Passwort ein."
          />
        ) : null}
        {f ? <DevicesTile fritz={f} filter={filter} onFilter={setFilter} /> : null}
      </div>
      {rebootOpen ? (
        <Dialog
          open
          onClose={() => {
            if (!reboot.isPending) setRebootOpen(false);
          }}
          title="FRITZ!Box neu starten?"
          dismissable={!reboot.isPending}
        >
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Internet, WLAN und Telefonie sind für einige Minuten weg. Server, die nur über das
              Internet erreichbar sind, melden sich danach wieder.
            </p>
            <p className="hz-dialog-text">Dafür ist ein frischer Code aus der App nötig.</p>
            {shown(reboot.error) ? <FormError title={shown(reboot.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRebootOpen(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button
                variant="danger"
                icon="power"
                disabled={reboot.isPending}
                onClick={() => reboot.mutate()}
              >
                Neu starten
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function NetworkOff(): ReactElement {
  return (
    <Tile title="Netzwerk" icon="wifi">
      <div className="app-empty-block" data-testid="module-off">
        <p className="app-empty">
          Modul ausgeschaltet. FRITZ!Box und DNS-Filter sind in dieser Zentrale nicht aktiv.
        </p>
        <div>
          <Link className="hz-btn hz-btn-secondary hz-btn-sm" to="/settings#module">
            <span>Einstellungen → Module</span>
          </Link>
        </div>
      </div>
    </Tile>
  );
}
