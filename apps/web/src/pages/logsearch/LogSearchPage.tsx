import type { LogSearchHit, LogSearchRequest, LogSearchResponse } from '@hz/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { useServers } from '../../lib/data.js';
import { formatNumber, formatWhen, plural } from '../../lib/format.js';
import {
  highlightSegments,
  LOG_SERVER_STATE,
  logSearchBody,
  logSearchErrorText,
  searchLogs,
  SINCE_OPTIONS,
  type LogSearchDraft,
} from '../../lib/ops.js';

const emptyDraft: LogSearchDraft = {
  query: '',
  sinceMinutes: 60,
  serverIds: [],
  container: '',
  caseSensitive: false,
};

/**
 * /logs (module logsearch): plain-text search over the container logs of all servers.
 * One POST per search (rate limit 10/min), results newest first with the match marked.
 */
export function LogSearchPage(): ReactElement {
  const servers = useServers();
  const [draft, setDraft] = useState<LogSearchDraft>(emptyDraft);
  const [allServers, setAllServers] = useState(true);
  const [errors, setErrors] = useState<{ query?: string; container?: string }>({});
  const search = useMutation({ mutationFn: searchLogs });

  function set<K extends keyof LogSearchDraft>(key: K, value: LogSearchDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === 'query' || key === 'container') setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = logSearchBody({ ...draft, serverIds: allServers ? [] : draft.serverIds });
    if (!res.ok) {
      setErrors({ [res.field]: res.error });
      return;
    }
    if (!allServers && draft.serverIds.length === 0) return;
    setErrors({});
    search.mutate(res.body);
  }

  const serverList = servers.data ?? [];
  const noServerPicked = !allServers && draft.serverIds.length === 0;

  return (
    <div className="app-stack">
      <Tile title="Logs durchsuchen" icon="terminal">
        <form className="hz-form" onSubmit={submit} noValidate role="search">
          <div className="app-fields">
            <Field
              className="app-fields-wide"
              label="Suchtext"
              type="search"
              mono
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={draft.query}
              onChange={(e) => set('query', e.target.value)}
              hint="Reine Textsuche, kein Regex. Mindestens 2 Zeichen."
              error={errors.query}
            />
            <SelectField
              label="Zeitraum"
              value={String(draft.sinceMinutes)}
              onChange={(e) => set('sinceMinutes', Number(e.target.value))}
              options={SINCE_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label }))}
            />
            <Field
              label="Container"
              mono
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              placeholder="alle"
              value={draft.container}
              onChange={(e) => set('container', e.target.value)}
              hint="Teil des Namens, z. B. nginx."
              error={errors.container}
            />
          </div>
          <div className="app-rows">
            <Toggle
              label="Groß/Klein beachten"
              hint={draft.caseSensitive ? 'an · „Error“ findet nicht „error“' : 'aus'}
              checked={draft.caseSensitive}
              onChange={(v) => set('caseSensitive', v)}
            />
            <Toggle
              label="Alle Server"
              hint={allServers ? 'an · jeder verbundene Server' : 'aus · Server unten wählen'}
              checked={allServers}
              onChange={setAllServers}
            />
            {allServers
              ? null
              : serverList.map((s) => (
                  <Toggle
                    key={s.id}
                    label={s.name}
                    hint={s.connected ? undefined : 'offline'}
                    checked={draft.serverIds.includes(s.id)}
                    onChange={(on) =>
                      set(
                        'serverIds',
                        on
                          ? [...draft.serverIds, s.id]
                          : draft.serverIds.filter((id) => id !== s.id),
                      )
                    }
                  />
                ))}
          </div>
          {noServerPicked ? (
            <p className="app-text" role="status">
              Mindestens einen Server wählen.
            </p>
          ) : null}
          {search.error ? <FormError title={logSearchErrorText(search.error)} /> : null}
          <div className="hz-form-actions">
            <Button variant="primary" type="submit" disabled={search.isPending || noServerPicked}>
              {search.isPending ? 'Sucht …' : 'Suchen'}
            </Button>
          </div>
        </form>
      </Tile>
      {search.data && search.variables ? (
        <LogSearchResults result={search.data} request={search.variables} />
      ) : null}
    </div>
  );
}

export function LogSearchResults({
  result,
  request,
}: {
  result: LogSearchResponse;
  request: LogSearchRequest;
}): ReactElement {
  const truncated =
    result.servers.some((s) => s.truncated) || result.hits.length >= request.maxMatches;
  const searched = result.servers.filter((s) => s.state === 'ok').length;

  return (
    <>
      <Tile
        title="Server"
        icon="server"
        count={`${formatNumber(searched, 0)}/${formatNumber(result.servers.length, 0)}`}
        flush
      >
        {result.servers.length === 0 ? (
          <p className="app-empty app-pad">Kein Server verbunden.</p>
        ) : (
          result.servers.map((s) => {
            const st = LOG_SERVER_STATE[s.state];
            return (
              <div className="hz-row" key={s.serverId} data-testid="logsearch-server">
                <div className="hz-row-main">
                  <span className="hz-row-name">{s.name}</span>
                  <span className="hz-row-sub">
                    {s.state === 'ok'
                      ? plural(s.scannedContainers, 'Container', 'Container') + ' durchsucht'
                      : st.label}
                  </span>
                </div>
                <div className="hz-row-meta app-meta-gap">
                  {s.truncated ? <Badge tone="warn">gekürzt</Badge> : null}
                  <StatusDot status={st.status} label={st.label} />
                </div>
              </div>
            );
          })
        )}
      </Tile>
      <Tile
        title="Treffer"
        icon="terminal"
        count={formatNumber(result.hits.length, 0)}
        actions={<span className="app-hit-meta">{formatNumber(result.tookMs / 1000, 1)} s</span>}
        flush
      >
        {truncated ? (
          <div className="app-pad">
            <Alert tone="warn" title="Ergebnis gekürzt.">
              Es gibt mehr Treffer oder mehr Zeilen, als durchsucht wurden. Zeitraum, Server oder
              Container eingrenzen.
            </Alert>
          </div>
        ) : null}
        {result.hits.length === 0 ? (
          <p className="app-empty app-pad">Keine Treffer für „{request.query}“.</p>
        ) : (
          <ol className="app-hits" aria-label="Treffer, neueste zuerst">
            {result.hits.map((h, i) => (
              <LogHit key={i} hit={h} query={request.query} caseSensitive={request.caseSensitive} />
            ))}
          </ol>
        )}
      </Tile>
    </>
  );
}

/** One matching line. Everything is React text; the match sits in <mark>. */
export function LogHit({
  hit,
  query,
  caseSensitive,
}: {
  hit: LogSearchHit;
  query: string;
  caseSensitive: boolean;
}): ReactElement {
  const segments = highlightSegments(hit.text, query, caseSensitive);
  return (
    <li className="app-hit" data-testid="log-hit">
      <div className="app-hit-meta">
        <span>{hit.ts ? formatWhen(new Date(hit.ts)) : '—'}</span>
        <span>{hit.serverName}</span>
        <span className="app-hit-ctr">{hit.containerName}</span>
        {hit.stream === 'stderr' ? <Badge>stderr</Badge> : null}
      </div>
      <pre className="app-hit-line">
        {segments.map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : s.text))}
      </pre>
    </li>
  );
}
