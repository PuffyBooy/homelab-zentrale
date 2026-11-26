import type { AzureDiskType, AzureRegion, CloudBudget } from '@hz/shared';
import type { ReactElement } from 'react';
import { Alert, Badge, StatusDot } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import {
  COST_SOURCE_TEXT,
  PUBLIC_IP_EUR_PER_MONTH,
  budgetStatus,
  budgetText,
  costLine,
  diskSizeOptions,
  diskTypeOptions,
  formatEur,
  formatEurHour,
  regionOptions,
  type MachineErrors,
} from '../../lib/cloud.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import type { MachineOrder } from './useMachineOrder.js';

export interface OrderFieldsProps {
  order: MachineOrder;
  budget: CloudBudget | undefined;
  errors: MachineErrors;
  /** Called when the admin types a machine name (stops the default from the game name). */
  onNameTyped?: () => void;
}

/**
 * Azure order: name, size (recommendation, free tier, too small disabled), region, disk,
 * public IP, idle time, the cost box and the price confirmation. Used on the Cloud page
 * and in the gameserver form ("Neuer Azure-Server …"). The submit button is the
 * parent's; it stays disabled until `order.ready`.
 */
export function OrderFields({
  order,
  budget,
  errors,
  onNameTyped,
}: OrderFieldsProps): ReactElement {
  const { draft, set, selected } = order;
  return (
    <fieldset className="app-fieldset" data-testid="cloud-order">
      <legend className="hz-label">Neuer Azure-Server</legend>
      <div className="app-fields">
        <Field
          label="Name des Servers"
          mono
          value={draft.name}
          onChange={(e) => {
            onNameTyped?.();
            set('name', e.target.value);
          }}
          hint="VM-Name bei Azure und Hostname im Tailnet"
          error={errors.name}
          maxLength={32}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <SelectField
          label="Größe"
          value={draft.size}
          onChange={(e) => set('size', e.target.value)}
          options={
            order.options.length
              ? order.options.map((o) => ({
                  value: o.size,
                  label: o.label,
                  disabled: o.disabledReason !== null,
                }))
              : [
                  {
                    value: '',
                    label: order.pricesLoading ? 'Preise werden geladen …' : 'Keine Größen',
                  },
                ]
          }
          hint={
            selected
              ? selected.burstable
                ? 'B-Serie: volle CPU nur in Spitzen, reicht für kleine Runden.'
                : 'Feste CPU-Leistung.'
              : undefined
          }
          error={errors.size}
        />
        <SelectField
          label="Region"
          value={draft.region}
          onChange={(e) => set('region', e.target.value as AzureRegion)}
          options={regionOptions}
        />
        <Field
          label="Schlafen nach … Min ohne Spiel"
          mono
          inputMode="numeric"
          value={draft.idleMinutes}
          onChange={(e) => set('idleMinutes', e.target.value)}
          hint="Liegen alle Spiele so lange still, wird die VM gestoppt. 0 = nie."
          error={errors.idleMinutes}
          autoComplete="off"
        />
        <SelectField
          label="Disk"
          value={draft.diskType}
          onChange={(e) => set('diskType', e.target.value as AzureDiskType)}
          options={diskTypeOptions}
        />
        <SelectField
          label="Disk-Größe"
          value={String(draft.diskGb)}
          onChange={(e) => set('diskGb', Number(e.target.value))}
          options={diskSizeOptions}
          hint="Disk kostet auch im Schlaf."
        />
      </div>
      <label className="app-check">
        <input
          type="checkbox"
          checked={draft.publicIp}
          onChange={(e) => set('publicIp', e.target.checked)}
        />
        <span>
          Öffentliche IP für Freunde (ca. {formatEur(PUBLIC_IP_EUR_PER_MONTH)}/Monat, auch im
          Schlaf). Ohne nur über Tailscale.
        </span>
      </label>
      {order.pricesError ? <FormError title={errorText(order.pricesError)} /> : null}
      <CostBox order={order} budget={budget} />
      <OrderConfirm order={order} />
    </fieldset>
  );
}

/** Running, sleeping and full-month price of the chosen size, plus the budget state. */
export function CostBox({
  order,
  budget,
}: {
  order: Pick<MachineOrder, 'selected'>;
  budget: CloudBudget | undefined;
}): ReactElement {
  const cost = order.selected?.cost;
  const b = budget ? budgetStatus(budget) : null;
  return (
    <div className="app-cost" data-testid="cloud-cost" aria-live="polite">
      {cost ? (
        <p className="app-cost-line">
          <span>{costLine(cost)}</span>
          <Badge tone={cost.source === 'live' ? 'info' : 'neutral'}>
            {COST_SOURCE_TEXT[cost.source]}
          </Badge>
        </p>
      ) : (
        <p className="app-empty">Größe wählen, dann stehen hier die Kosten.</p>
      )}
      {budget && b ? (
        <p className="app-cost-budget">
          <StatusDot status={b.status} label={b.label} className="app-status-auto" />
          <span>{budgetText(budget)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Required tick with the price; a second one when the budget is used up. */
export function OrderConfirm({ order }: { order: MachineOrder }): ReactElement {
  const eur = order.shownEur;
  return (
    <div className="app-stack">
      {order.conflict === 'price' && eur !== undefined ? (
        <Alert tone="warn" title={`Preis hat sich geändert: jetzt ${formatEurHour(eur)}.`}>
          {order.refusedEur !== null ? `Bestätigt waren ${formatEurHour(order.refusedEur)}. ` : ''}
          Bitte den neuen Preis bestätigen.
        </Alert>
      ) : null}
      {order.needsOverBudget ? (
        <Alert tone="crit" title="Cloud-Budget aufgebraucht.">
          Eine Bestellung geht nur mit ausdrücklicher Bestätigung. Das Budget änderst du oben unter
          Azure-Zugang.
        </Alert>
      ) : null}
      <label className="app-check">
        <input
          type="checkbox"
          checked={order.confirmed}
          disabled={eur === undefined || order.pending}
          onChange={(e) => order.setConfirmed(e.target.checked)}
          required
        />
        <span>
          {eur !== undefined
            ? `Ich bestelle diesen Server für ca. ${formatEurHour(eur)}. bei Azure`
            : 'Ich bestelle diesen Server bei Azure'}
        </span>
      </label>
      {order.needsOverBudget ? (
        <label className="app-check">
          <input
            type="checkbox"
            checked={order.overBudget}
            disabled={order.pending}
            onChange={(e) => order.setOverBudget(e.target.checked)}
          />
          <span>Trotz aufgebrauchtem Budget bestellen</span>
        </label>
      ) : null}
      {order.error &&
      order.conflict !== 'price' &&
      order.conflict !== 'budget' &&
      !isApiError(order.error, 'step_up_required') ? (
        <FormError title={errorText(order.error)} />
      ) : null}
    </div>
  );
}
