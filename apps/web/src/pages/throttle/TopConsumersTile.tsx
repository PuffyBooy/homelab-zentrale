import type { TopConsumer, TopConsumersResponse } from '@hz/shared';
import { useState, type ReactElement } from 'react';
import { Button, ServiceRow, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatNumber, formatWhen } from '../../lib/format.js';
import { consumerActions, throttleBadge } from '../../lib/throttle.js';
import { StopConfirmDialog, ThrottleDialog, type ThrottleTarget } from './ThrottleDialogs.js';
import { useThrottle } from './useThrottle.js';

type Open = { kind: 'throttle' | 'stop'; c: TopConsumer } | null;

function cpuText(c: TopConsumer): string {
  return c.cpuPct == null ? 'CPU —' : `CPU ${formatNumber(c.cpuPct, c.cpuPct < 10 ? 1 : 0)} %`;
}

function ramText(c: TopConsumer): string {
  return `RAM ${formatBytes(c.memBytes)}`;
}

/** Dialog target: games stop through the game route, `wichtig` gets a hint. */
export function consumerTarget(c: TopConsumer): ThrottleTarget {
  return {
    id: c.containerId,
    name: c.containerName,
    serverName: c.serverName,
    gameId: c.isGame ? c.gameId : null,
    priority: c.priority,
  };
}

export interface ConsumerRowProps {
  c: TopConsumer;
  by: 'cpu' | 'ram';
  onThrottle: (c: TopConsumer) => void;
  onUnthrottle: (c: TopConsumer) => void;
  onStop: (c: TopConsumer) => void;
  busy: boolean;
}

/** One row: status, name, server, the value that counts, Drosseln/Stoppen. */
export function ConsumerRow({
  c,
  by,
  onThrottle,
  onUnthrottle,
  onStop,
  busy,
}: ConsumerRowProps): ReactElement {
  const can = consumerActions(c);
  const value = by === 'cpu' ? cpuText(c) : ramText(c);
  // The priority goes into meta (not truncated); the host line keeps only the server.
  const tier = c.protected ? 'Zentrale/Agent' : c.priority;
  const meta = c.throttled
    ? `${value} · ${throttleBadge(c.throttled)} · ${tier}`
    : `${value} · ${tier}`;
  const actions = c.protected ? undefined : (
    <>
      {can.throttle ? (
        <Button
          size="sm"
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={`${c.containerName} drosseln`}
          disabled={busy}
          onClick={() => onThrottle(c)}
        >
          Drosseln
        </Button>
      ) : null}
      {can.unthrottle ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Drosselung von ${c.containerName} aufheben`}
          disabled={busy}
          onClick={() => onUnthrottle(c)}
        >
          Aufheben
        </Button>
      ) : null}
      {can.stop ? (
        <Button
          size="sm"
          variant="ghost"
          aria-haspopup="dialog"
          aria-label={`${c.containerName} stoppen`}
          disabled={busy}
          onClick={() => onStop(c)}
        >
          Stoppen
        </Button>
      ) : null}
    </>
  );
  return (
    <ServiceRow
      name={c.containerName}
      host={c.serverName}
      status={c.throttled ? 'warn' : 'ok'}
      meta={meta}
      actions={actions}
    />
  );
}

function List({
  title,
  list,
  by,
  ...handlers
}: {
  title: string;
  list: TopConsumer[];
  by: 'cpu' | 'ram';
} & Omit<ConsumerRowProps, 'c' | 'by'>): ReactElement {
  return (
    <section className="app-consumers-col" aria-label={title}>
      <h3 className="hz-label app-consumers-head">{title}</h3>
      {list.length ? (
        list.map((c) => <ConsumerRow key={c.containerId} c={c} by={by} {...handlers} />)
      ) : (
        <p className="app-empty app-pad">Kein laufender Container.</p>
      )}
    </section>
  );
}

/**
 * Overview tile "Wer frisst gerade?" (ROADMAP M10): top 3 by CPU and by RAM over all
 * servers. "Stoppen" asks first, protected containers (hz.role) have no buttons.
 */
export function TopConsumersTile({
  data,
  error,
}: {
  data: TopConsumersResponse;
  error?: unknown;
}): ReactElement {
  const [open, setOpen] = useState<Open>(null);
  const act = useThrottle();
  const handlers = {
    onThrottle: (c: TopConsumer) => setOpen({ kind: 'throttle', c }),
    onStop: (c: TopConsumer) => setOpen({ kind: 'stop', c }),
    onUnthrottle: (c: TopConsumer) => act.mutate({ kind: 'unthrottle', id: c.containerId }),
    busy: act.isPending,
  };
  return (
    <Tile
      title="Wer frisst gerade?"
      icon="cpu"
      count="Top 3"
      span={4}
      flush
      footer={
        <span className="app-foot-text">
          Stand {formatWhen(new Date(data.updatedAt))} · über alle Server
        </span>
      }
    >
      {error ? (
        <div className="app-pad">
          <FormError title={errorText(error)} />
        </div>
      ) : null}
      {act.error ? (
        <div className="app-pad">
          <FormError title={errorText(act.error)} />
        </div>
      ) : null}
      <div className="app-consumers">
        <List title="CPU" list={data.byCpu} by="cpu" {...handlers} />
        <List title="RAM" list={data.byRam} by="ram" {...handlers} />
      </div>
      {open?.kind === 'throttle' ? (
        <ThrottleDialog target={consumerTarget(open.c)} onClose={() => setOpen(null)} />
      ) : null}
      {open?.kind === 'stop' ? (
        <StopConfirmDialog
          target={consumerTarget(open.c)}
          isGame={open.c.isGame}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </Tile>
  );
}
