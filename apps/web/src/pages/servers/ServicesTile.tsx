import type { ServiceOp, ServiceUnitInfo, ServicesResponse } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { plural } from '../../lib/format.js';
import {
  SERVICES_HINT,
  SERVICE_OP_ARIA,
  SERVICE_OP_LABEL,
  fetchServices,
  filterUnits,
  serviceAction,
  serviceDoneText,
  servicesKey,
  unitOps,
  unitStatus,
  type UnitView,
} from '../../lib/serverAdmin.js';

/** Rows shown at once; the filter narrows the rest down. */
const MAX_ROWS = 100;

interface Pending {
  unit: string;
  op: ServiceOp;
}

/**
 * "Dienste" (ROADMAP M16): systemd units, failed first. Start/Stopp/Neustart only for
 * units the agent allows (HZ_AGENT_SERVICES, never the deny list); Stopp asks first.
 * The failed units from the inventory show right away, before the list is loaded.
 */
export function ServicesTile({
  serverId,
  serverName,
  failed,
  offline,
}: {
  serverId: string;
  serverName: string;
  failed: readonly string[];
  offline: boolean;
}): ReactElement {
  const qc = useQueryClient();
  const [view, setView] = useState<UnitView>('running');
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const q = useQuery({
    queryKey: servicesKey(serverId),
    queryFn: ({ signal }) => fetchServices(serverId, signal),
    enabled: !offline,
    staleTime: 30_000,
    retry: false,
  });
  const act = useMutation({
    mutationFn: (p: Pending) => serviceAction(serverId, p.unit, p.op),
    onSettled: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: servicesKey(serverId) });
    },
  });

  function run(p: Pending): void {
    if (p.op === 'stop') setConfirm(p);
    else act.mutate(p);
  }

  return (
    <div className="hz-span-4 app-anchor" id="dienste">
      <ServicesView
        serverName={serverName}
        failed={failed}
        offline={offline}
        data={q.data}
        loading={q.isFetching}
        error={q.error ? errorText(q.error) : null}
        view={view}
        query={query}
        onView={setView}
        onQuery={setQuery}
        onRefresh={() => void q.refetch()}
        onAction={run}
        busyUnit={act.isPending ? (act.variables?.unit ?? null) : null}
        done={
          act.isSuccess && act.variables
            ? serviceDoneText(act.variables.unit, act.variables.op)
            : null
        }
        actionError={act.error && !confirm ? errorText(act.error) : null}
      />
      <Dialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
          act.reset();
        }}
        title={confirm ? `${confirm.unit} stoppen` : 'Dienst stoppen'}
      >
        <div className="hz-dialog-body">
          <p className="hz-dialog-text">
            {confirm?.unit} auf {serverName} läuft danach nicht mehr, bis du ihn wieder startest
            oder der Server neu startet.
          </p>
          {act.error ? <FormError title={errorText(act.error)} /> : null}
          <div className="hz-dialog-foot">
            <Button
              onClick={() => {
                setConfirm(null);
                act.reset();
              }}
            >
              Abbrechen
            </Button>
            <Button
              variant="danger"
              icon="stop"
              disabled={act.isPending}
              onClick={() => confirm && act.mutate(confirm)}
              data-autofocus=""
            >
              Stoppen
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function ServicesView({
  serverName,
  failed,
  offline,
  data,
  loading,
  error,
  view,
  query,
  onView,
  onQuery,
  onRefresh,
  onAction,
  busyUnit,
  done,
  actionError,
}: {
  serverName: string;
  failed: readonly string[];
  offline: boolean;
  data: ServicesResponse | undefined;
  loading: boolean;
  error: string | null;
  view: UnitView;
  query: string;
  onView: (v: UnitView) => void;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  onAction: (p: Pending) => void;
  busyUnit: string | null;
  done: string | null;
  actionError: string | null;
}): ReactElement {
  const failedCount = data ? data.units.filter((u) => u.active === 'failed').length : failed.length;
  const list = data ? filterUnits(data.units, view, query) : [];
  const shown = list.slice(0, MAX_ROWS);
  return (
    <Tile
      title="Dienste"
      icon="server"
      span={4}
      status={failedCount > 0 ? 'warn' : data?.systemd ? 'ok' : undefined}
      statusLabel={failedCount > 0 ? `${failedCount} fehlgeschlagen` : undefined}
      count={data?.systemd ? plural(data.units.length, 'Unit', 'Units') : undefined}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          aria-label="Dienste neu laden"
          disabled={offline || loading}
          onClick={onRefresh}
        />
      }
      footer={<span className="app-foot-text">{SERVICES_HINT}</span>}
    >
      {!data && failed.length ? (
        <div className="app-rows" role="group" aria-label="Fehlgeschlagene Dienste">
          {failed.map((name) => (
            <ServiceRow key={name} name={name} host="fehlgeschlagen" status="crit" />
          ))}
        </div>
      ) : null}

      {offline ? (
        <p className="app-empty">
          Agent offline. Die Liste kommt, sobald {serverName} sich meldet.
        </p>
      ) : error ? (
        <FormError title={error} />
      ) : !data ? (
        <p className="app-empty" role="status">
          Lade Dienste …
        </p>
      ) : !data.systemd ? (
        <p className="app-empty">{serverName} hat kein systemd. Hier gibt es keine Dienste.</p>
      ) : (
        <>
          <div className="app-svc-tools">
            <Field
              label="Filter"
              type="search"
              value={query}
              placeholder="z. B. nginx"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onQuery(e.target.value)}
            />
            <div className="app-range" role="group" aria-label="Anzeigen">
              <Button
                size="sm"
                variant={view === 'running' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'running'}
                onClick={() => onView('running')}
              >
                Nur laufende
              </Button>
              <Button
                size="sm"
                variant={view === 'all' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'all'}
                onClick={() => onView('all')}
              >
                Alle
              </Button>
            </div>
          </div>
          {done ? <Alert tone="ok" title={done} /> : null}
          {actionError ? <FormError title={actionError} /> : null}
          {shown.length ? (
            <div className="app-rows app-svc-rows" role="group" aria-label="Dienste">
              {shown.map((u) => (
                <UnitRow key={u.name} u={u} busy={busyUnit === u.name} onAction={onAction} />
              ))}
            </div>
          ) : (
            <p className="app-empty">Kein Dienst passt zum Filter.</p>
          )}
          {list.length > shown.length ? (
            <p className="app-text">
              {plural(list.length - shown.length, 'weiterer Dienst', 'weitere Dienste')}. Filter
              nutzen.
            </p>
          ) : null}
        </>
      )}
    </Tile>
  );
}

export function UnitRow({
  u,
  busy,
  onAction,
}: {
  u: ServiceUnitInfo;
  busy: boolean;
  onAction: (p: Pending) => void;
}): ReactElement {
  const ops = unitOps(u);
  return (
    <ServiceRow
      name={u.name}
      host={u.description || u.load}
      status={unitStatus(u)}
      meta={<span className="app-svc-state">{`${u.active} · ${u.sub}`}</span>}
      actions={
        ops.length ? (
          <>
            {ops.map((op) => (
              <Button
                key={op}
                size="sm"
                variant="ghost"
                icon={op === 'stop' ? 'stop' : op === 'start' ? 'play' : 'refresh'}
                disabled={busy}
                aria-label={`${u.name} ${SERVICE_OP_ARIA[op]}`}
                onClick={() => onAction({ unit: u.name, op })}
              >
                {SERVICE_OP_LABEL[op]}
              </Button>
            ))}
          </>
        ) : undefined
      }
    />
  );
}
