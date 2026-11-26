import type { CloudBudget, CloudMachine, CloudOverview } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Metric, StatusDot, Tile, UsageBar } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import {
  budgetStatus,
  CLOUD_TARGET,
  budgetText,
  cloudConflict,
  cloudKey,
  fetchCloud,
  formatEur,
  formatEurHour,
  MACHINE_PARAM,
  startMachine,
  stopMachine,
  updateMachine,
  useCloudOverview,
  validateMachine,
  type MachineErrors,
} from '../../lib/cloud.js';
import { useGames } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatNumber } from '../../lib/format.js';
import { isModuleOn } from '../../lib/modules.js';
import { useModules } from '../../lib/useModules.js';
import { useNow } from '../../lib/useNow.js';
import { AzureTile } from './AzureTile.js';
import { DeleteMachineDialog } from './DeleteMachineDialog.js';
import { MachinesTile, type MachineAction } from './MachinesTile.js';
import { OrderFields } from './OrderFields.js';
import { useMachineOrder } from './useMachineOrder.js';

/**
 * /cloud (M22, module cloud): problems first (budget, Azure errors), then the machines
 * with state, costs and actions, then the Azure account and the order form.
 */
export function CloudPage(): ReactElement | null {
  const qc = useQueryClient();
  const overview = useCloudOverview();
  const modules = useModules();
  const games = useGames(isModuleOn(modules, 'games'));
  const [params] = useSearchParams();
  const focusId = params.get(MACHINE_PARAM);
  const now = useNow(30_000);
  const [deleting, setDeleting] = useState<CloudMachine | null>(null);
  const [overBudgetStart, setOverBudgetStart] = useState<CloudMachine | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const replace = (m: CloudMachine): void => {
    qc.setQueryData<CloudOverview>(cloudKey, (old) =>
      old ? { ...old, machines: old.machines.map((x) => (x.id === m.id ? m : x)) } : old,
    );
    void qc.invalidateQueries({ queryKey: cloudKey });
  };

  const act = useMutation({
    mutationFn: async (v: { m: CloudMachine; action: 'start' | 'stop'; overBudget?: boolean }) =>
      v.action === 'start' ? startMachine(v.m.id, v.overBudget ?? false) : stopMachine(v.m.id),
    onMutate: () => setRowError(null),
    onSuccess: (m) => {
      setOverBudgetStart(null);
      replace(m);
    },
    onError: async (err, v) => {
      if (isApiError(err, 'step_up_required')) return;
      if (v.action === 'start' && !v.overBudget && isApiError(err) && err.status === 409) {
        const fresh = await qc
          .fetchQuery({
            queryKey: cloudKey,
            queryFn: ({ signal }) => fetchCloud(signal),
            staleTime: 0,
          })
          .catch(() => undefined);
        const budget = fresh?.budget ?? overview.data?.budget;
        if (cloudConflict(err, budget ? { budget } : {}) === 'budget') {
          setOverBudgetStart(v.m);
          return;
        }
      }
      setOverBudgetStart(null);
      setRowError({ id: v.m.id, text: errorText(err) });
    },
  });

  const idle = useMutation({
    mutationFn: (v: { m: CloudMachine; minutes: number }) => updateMachine(v.m.id, v.minutes),
    onMutate: () => setRowError(null),
    onSuccess: replace,
    onError: (err, v) => setRowError({ id: v.m.id, text: errorText(err) }),
  });

  function onAction(m: CloudMachine, action: MachineAction): void {
    if (action === 'delete') setDeleting(m);
    else act.mutate({ m, action });
  }

  if (overview.isError && !overview.data) return <FormError title={errorText(overview.error)} />;
  if (!overview.data) return null;
  const data = overview.data;

  return (
    <>
      <div className="hz-grid app-grid">
        <MachinesTile
          machines={data.machines}
          games={games.data}
          focusId={focusId}
          pendingId={
            act.isPending ? act.variables.m.id : idle.isPending ? idle.variables.m.id : null
          }
          rowError={rowError}
          onAction={onAction}
          onIdle={(m, minutes) => idle.mutate({ m, minutes })}
        />
        <BudgetTile budget={data.budget} />
        <AzureTile settings={data.azure} now={now} />
        {data.azure.status === 'ok' ? (
          <OrderTile overview={data} gamesOn={isModuleOn(modules, 'games')} />
        ) : (
          <Tile title="Server bestellen" icon="plus" span={4}>
            <p className="app-empty">
              Bestellen geht, sobald der Azure-Zugang eingetragen und getestet ist.
            </p>
          </Tile>
        )}
      </div>
      {deleting ? (
        <DeleteMachineDialog machine={deleting} onClose={() => setDeleting(null)} />
      ) : null}
      {overBudgetStart ? (
        <OverBudgetDialog
          machine={overBudgetStart}
          budget={data.budget}
          busy={act.isPending}
          onConfirm={() => act.mutate({ m: overBudgetStart, action: 'start', overBudget: true })}
          onClose={() => setOverBudgetStart(null)}
        />
      ) : null}
    </>
  );
}

/** Month so far of the budget as UsageBar, the projection and the state with text. */
export function BudgetTile({ budget: b }: { budget: CloudBudget }): ReactElement {
  const st = budgetStatus(b);
  return (
    <Tile title="Budget" icon="cpu" status={st.status} statusLabel={st.label} span={2}>
      <div className="app-stack" data-testid="cloud-budget">
        <div className="app-metrics">
          <Metric label="Monat bisher" value={formatNumber(b.monthEur, 2)} unit="€" />
          <Metric label="Hochrechnung" value={formatNumber(b.projectedEur, 2)} unit="€" />
          <Metric label="Budget" value={formatNumber(b.limitEur, 2)} unit="€" />
        </div>
        <UsageBar
          label="Budget"
          value={b.percent}
          detail={`${formatEur(b.monthEur)} von ${formatEur(b.limitEur)} · ${formatNumber(Math.round(b.percent), 0)} %`}
          warnAt={80}
          critAt={100}
        />
        <p className="app-cost-budget">
          <StatusDot status={st.status} label={st.label} className="app-status-auto" />
          <span>{budgetText(b)}</span>
        </p>
        <p className="app-foot-text">
          Hochrechnung: alles bleibt bis Monatsende so, wie es jetzt ist.
        </p>
      </div>
    </Tile>
  );
}

function OverBudgetDialog({
  machine,
  budget,
  busy,
  onConfirm,
  onClose,
}: {
  machine: CloudMachine;
  budget: CloudBudget;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`${machine.name} trotz Budget starten?`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          {budgetText(budget)} Läuft der Server, kostet er ca.{' '}
          {formatEurHour(machine.cost.runningEurPerHour)}.
        </p>
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="danger"
            icon="play"
            disabled={busy}
            onClick={onConfirm}
            data-autofocus=""
          >
            Trotzdem starten
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Order without a game: same fields as in the gameserver form. */
function OrderTile({
  overview,
  gamesOn,
}: {
  overview: CloudOverview;
  gamesOn: boolean;
}): ReactElement {
  const [, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<MachineErrors>({});
  const order = useMachineOrder({
    region: overview.azure.region,
    name: '',
    gameRamGb: 0,
    overview,
    onCreated: (m) => {
      setOpen(false);
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(MACHINE_PARAM, m.id);
        return next;
      });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validateMachine(
      order.draft,
      overview.machines.map((m) => m.name),
    );
    setErrors(res.ok ? {} : res.errors);
    if (!res.ok || !order.ready) return;
    order.submit();
  }

  return (
    <Tile
      title="Server bestellen"
      icon="plus"
      span={4}
      actions={
        open ? null : (
          <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
            Server ohne Gameserver bestellen
          </Button>
        )
      }
    >
      {open ? (
        <form className="hz-form" onSubmit={submit} noValidate>
          <OrderFields
            order={order}
            budget={overview.budget}
            errors={errors}
            onNameTyped={() => setErrors(({ name: _drop, ...rest }) => rest)}
          />
          <div className="hz-form-actions">
            <Button onClick={() => setOpen(false)}>Abbrechen</Button>
            <Button
              variant="primary"
              type="submit"
              icon="cloud"
              disabled={!order.ready || order.pending}
            >
              {order.pending ? 'Wird bestellt …' : 'Bestellen'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="app-text">
          Meist bestellst du einen Server direkt beim Anlegen eines Gameservers (Ziel „Neuer
          Azure-Server“
          {gamesOn ? (
            <>
              {', '}
              <Link to={`/games/new?server=${encodeURIComponent(CLOUD_TARGET)}`}>
                Gameserver auf neuem Azure-Server
              </Link>
            </>
          ) : null}
          ). Hier geht es auch ohne Spiel.
        </p>
      )}
    </Tile>
  );
}
