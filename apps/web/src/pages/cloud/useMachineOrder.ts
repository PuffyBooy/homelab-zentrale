import type { AzureRegion, CloudMachine, CloudOverview, CloudPendingGame } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { isApiError } from '../../lib/api.js';
import {
  azurePricesKey,
  cloudConflict,
  cloudKey,
  createMachine,
  orderReady,
  pickSize,
  emptyMachineDraft,
  fetchAzurePrices,
  fetchCloud,
  machineCreateBody,
  samePrice,
  sizeOptions,
  type CloudConflict,
  type MachineDraft,
  type SizeOption,
} from '../../lib/cloud.js';

export interface MachineOrder {
  draft: MachineDraft;
  set: <K extends keyof MachineDraft>(key: K, value: MachineDraft[K]) => void;
  options: SizeOption[];
  selected: SizeOption | undefined;
  pricesLoading: boolean;
  pricesError: unknown;
  /** Running price per hour that is shown and sent as confirmEurPerHour. */
  shownEur: number | undefined;
  /** The checkbox "Ich bestelle …" is ticked for the price shown right now. */
  confirmed: boolean;
  setConfirmed: (on: boolean) => void;
  /** The budget is used up (before or after the order): a second tick is needed. */
  needsOverBudget: boolean;
  overBudget: boolean;
  setOverBudget: (on: boolean) => void;
  /** Last 409 of the core, after fresh prices and budget were read. */
  conflict: CloudConflict | null;
  /** Price per hour the core refused (only with conflict `price`). */
  refusedEur: number | null;
  /** Submit allowed: size chosen, price confirmed and, if needed, the budget override. */
  ready: boolean;
  pending: boolean;
  error: unknown;
  submit: (game?: CloudPendingGame) => void;
}

/**
 * State of an Azure order (Cloud page and gameserver form): prices for the current disk
 * and IP choice, the preselected size, the price confirmation and the 409 handling.
 * The confirmation is bound to the price: a different size or a new price unticks it.
 */
export function useMachineOrder({
  region,
  name,
  gameRamGb,
  overview,
  onCreated,
  enabled = true,
}: {
  /** Defaults until the admin changes them (they may arrive after the first render). */
  region: AzureRegion;
  name: string;
  gameRamGb: number;
  overview: CloudOverview | undefined;
  onCreated: (m: CloudMachine) => void;
  /** Off: no price request (gameserver form while another target is chosen). */
  enabled?: boolean;
}): MachineOrder {
  const qc = useQueryClient();
  const [changed, setChanged] = useState<Partial<MachineDraft>>({});
  const draft: MachineDraft = { ...emptyMachineDraft(region, name), ...changed };
  const [confirmedEur, setConfirmedEur] = useState<number | null>(null);
  const [overBudget, setOverBudget] = useState(false);
  const [conflict, setConflict] = useState<CloudConflict | null>(null);
  const [refusedEur, setRefusedEur] = useState<number | null>(null);
  const [coreEur, setCoreEur] = useState<{ key: string; eur: number } | null>(null);

  const q = {
    region: draft.region,
    diskType: draft.diskType,
    diskGb: draft.diskGb,
    publicIp: draft.publicIp,
  };
  const prices = useQuery({
    queryKey: azurePricesKey(q),
    queryFn: ({ signal }) => fetchAzurePrices(q, signal),
    staleTime: 60_000,
    enabled,
  });

  const options = useMemo(
    () => (prices.data ? sizeOptions(prices.data.sizes, gameRamGb) : []),
    [prices.data, gameRamGb],
  );

  // The recommendation is preselected; a size that no longer fits falls back to it.
  const size = pickSize(options, draft.size);
  const current: MachineDraft = size === draft.size ? draft : { ...draft, size };

  const selected = options.find((o) => o.size === size);
  // After price_changed the core's current price counts for exactly this choice.
  const choiceKey = `${size}|${draft.region}|${draft.diskType}|${draft.diskGb}|${draft.publicIp}`;
  const shownEur =
    coreEur?.key === choiceKey && selected ? coreEur.eur : selected?.cost.runningEurPerHour;
  const confirmed =
    confirmedEur !== null && shownEur !== undefined && samePrice(confirmedEur, shownEur);
  const needsOverBudget = overview?.budget.state === 'over' || conflict === 'budget';

  const create = useMutation({
    mutationFn: (vars: { eur: number; game: CloudPendingGame | undefined }) =>
      createMachine(
        machineCreateBody(current, vars.eur, {
          overBudget: needsOverBudget && overBudget,
          ...(vars.game ? { game: vars.game } : {}),
        }),
      ),
    onMutate: () => {
      setConflict(null);
      setRefusedEur(null);
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: cloudKey });
      onCreated(m);
    },
    onError: async (err, vars) => {
      if (!isApiError(err) || err.status !== 409) return;
      const sentKey = choiceKey;
      // Read fresh prices and budget, then decide what to ask again.
      const [p, o] = await Promise.all([
        prices.refetch(),
        qc
          .fetchQuery({
            queryKey: cloudKey,
            queryFn: ({ signal }) => fetchCloud(signal),
            staleTime: 0,
          })
          .catch(() => undefined),
      ]);
      const current =
        err.currentEurPerHour ?? p.data?.sizes.find((s) => s.size === size)?.cost.runningEurPerHour;
      const budget = o?.budget ?? overview?.budget;
      const kind = cloudConflict(err, {
        confirmed: vars.eur,
        ...(current !== undefined ? { current } : {}),
        ...(budget ? { budget } : {}),
      });
      setConflict(kind);
      if (kind === 'price') {
        setRefusedEur(vars.eur);
        setConfirmedEur(null);
        if (err.currentEurPerHour !== undefined) {
          setCoreEur({ key: sentKey, eur: err.currentEurPerHour });
        }
      }
      if (kind === 'budget') setOverBudget(false);
    },
  });

  return {
    draft: current,
    set: (key, value) => {
      setChanged((d) => ({ ...d, [key]: value }));
      if (key !== 'name' && key !== 'idleMinutes') setConflict(null);
    },
    options,
    selected,
    pricesLoading: prices.isLoading,
    pricesError: prices.error,
    confirmed,
    shownEur,
    setConfirmed: (on) => setConfirmedEur(on && shownEur !== undefined ? shownEur : null),
    needsOverBudget,
    overBudget,
    setOverBudget,
    conflict,
    refusedEur,
    ready: orderReady({ selected, confirmed, needsOverBudget, overBudget }),
    pending: create.isPending,
    error: create.error,
    submit: (game) => {
      if (shownEur === undefined || create.isPending) return;
      create.mutate({ eur: shownEur, game });
    },
  };
}
