import type { GithubSettings, RepoSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import { Alert, Badge, Button, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { useGithubSettings, useRepos } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatNumber, formatWhen, plural } from '../../lib/format.js';
import {
  addRepo,
  availableKey,
  deleteGithubToken,
  fetchAvailable,
  githubSettingsKey,
  reposKey,
  setGithubToken,
  tokenError,
  type AvailableRepo,
} from '../../lib/github.js';
import { mergeById } from '../../lib/live.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  if (isApiError(err, 'invalid_input'))
    return 'GitHub hat den Token abgelehnt. Rechte und Ablauf prüfen.';
  return errorText(err);
}

/**
 * SPEC 13: GitHub token (enter, replace, remove; step-up routes) and "Repo hinzufügen".
 * The token is write-only: the field is cleared after saving and never shown again.
 */
export function GithubTile(): ReactElement {
  const qc = useQueryClient();
  const settings = useGithubSettings();
  const repos = useRepos();
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (hash === '#github' && settings.data) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, settings.data]);

  const save = useMutation({
    mutationFn: (t: string) => setGithubToken(t),
    onSuccess: (s) => {
      setToken('');
      qc.setQueryData<GithubSettings>(githubSettingsKey, s);
      void qc.invalidateQueries({ queryKey: availableKey });
      void qc.invalidateQueries({ queryKey: reposKey });
    },
  });
  const remove = useMutation({
    mutationFn: deleteGithubToken,
    onSuccess: () => {
      setRemoving(false);
      void qc.invalidateQueries({ queryKey: githubSettingsKey });
      qc.removeQueries({ queryKey: availableKey });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const err = tokenError(token);
    setFieldError(err);
    if (!err) save.mutate(token.trim());
  }

  const s = settings.data;
  const saveError = shownError(save.error);

  return (
    <div id="github" ref={anchor} className="app-anchor">
      <Tile
        title="GitHub"
        icon="git"
        count={s?.login ?? undefined}
        status={s ? (s.error ? 'warn' : s.tokenSet ? 'ok' : 'off') : undefined}
      >
        {settings.isError && !s ? <FormError title={errorText(settings.error)} /> : null}
        {s ? (
          <>
            <dl className="app-kv">
              <dt>Token</dt>
              <dd>{s.tokenSet ? 'hinterlegt' : 'kein Token'}</dd>
              <dt>Konto</dt>
              <dd>{s.login ?? '—'}</dd>
              <dt>Abgleich</dt>
              <dd>
                {s.lastPollAt
                  ? `${formatWhen(new Date(s.lastPollAt))} · ${formatAgo(new Date(s.lastPollAt))}`
                  : 'noch keiner'}
              </dd>
              <dt>Rate-Limit</dt>
              <dd>
                {s.rateRemaining != null
                  ? `${formatNumber(s.rateRemaining, 0)} Anfragen übrig`
                  : '—'}
              </dd>
              <dt>Repos</dt>
              <dd>
                {repos.data ? (
                  <Link to="/github">{plural(repos.data.length, 'Repo', 'Repos')}</Link>
                ) : (
                  '—'
                )}
              </dd>
            </dl>
            {s.error ? (
              <Alert tone="warn" title={`GitHub-Abgleich gestört: ${s.error}`}>
                Token prüfen oder ersetzen. Repos zeigen bis dahin den letzten Stand.
              </Alert>
            ) : null}
            <form className="hz-form" onSubmit={submit} noValidate>
              <Field
                label={s.tokenSet ? 'Neuer Token' : 'Token'}
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                maxLength={255}
                onChange={(e) => {
                  setToken(e.target.value);
                  setFieldError(null);
                }}
                placeholder="github_pat_…"
                hint="Fine-grained Token: Contents, Actions und Metadata, nur lesen. Er wird verschlüsselt gespeichert und nie wieder angezeigt."
                error={fieldError}
              />
              {saveError ? <FormError title={saveError} /> : null}
              {save.isSuccess && !token ? (
                <Alert tone="ok" title="Token gespeichert.">
                  {save.data.login
                    ? `Angemeldet als ${save.data.login}.`
                    : 'Erster Abgleich läuft.'}
                </Alert>
              ) : null}
              <div className="hz-form-actions">
                {s.tokenSet ? (
                  <Button variant="danger" onClick={() => setRemoving(true)}>
                    Token entfernen
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  variant={s.tokenSet ? 'secondary' : 'primary'}
                  disabled={save.isPending}
                >
                  {s.tokenSet ? 'Token ersetzen' : 'Token speichern'}
                </Button>
                {s.tokenSet ? (
                  <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                    Repo hinzufügen
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        ) : settings.isPending ? (
          <p className="app-empty">Lade GitHub …</p>
        ) : null}
      </Tile>
      {removing ? (
        <Dialog open onClose={() => setRemoving(false)} title="GitHub-Token entfernen">
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Die Zentrale gleicht dann keine Repos mehr ab. Repos, Ziele und Verlauf bleiben
              gespeichert, Deploys per Knopf gehen erst mit neuem Token wieder.
            </p>
            {shownError(remove.error) ? <FormError title={shownError(remove.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRemoving(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Entfernen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {adding ? <AddRepoDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

const MAX_LIST = 50;

/** "Repo hinzufügen": repos the token can see, from /api/github/available. */
function AddRepoDialog({ onClose }: { onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const available = useQuery({
    queryKey: availableKey,
    queryFn: ({ signal }) => fetchAvailable(signal),
    staleTime: 60_000,
  });
  const add = useMutation({
    mutationFn: addRepo,
    onSuccess: (repo) => {
      qc.setQueryData<RepoSummary[]>(reposKey, (old) => (old ? mergeById(old, [repo]) : old));
      qc.setQueryData<AvailableRepo[]>(availableKey, (old) =>
        old?.map((r) => (r.fullName === repo.fullName ? { ...r, tracked: true } : r)),
      );
    },
  });
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = available.data ?? [];
    const hits = q ? all.filter((r) => r.fullName.toLowerCase().includes(q)) : all;
    return [...hits].sort(
      (a, b) => Number(a.tracked) - Number(b.tracked) || a.fullName.localeCompare(b.fullName),
    );
  }, [available.data, query]);
  const shown = list.slice(0, MAX_LIST);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Repo hinzufügen"
      className="app-dialog-wide hz-dialog-sheet"
    >
      <div className="hz-dialog-body">
        <Field
          label="Suchen"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="soundos"
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
        />
        {available.isError ? <FormError title={errorText(available.error)} /> : null}
        {add.error ? (
          <FormError
            title={
              isApiError(add.error, 'conflict')
                ? 'Das Repo verfolgt die Zentrale schon.'
                : errorText(add.error)
            }
          />
        ) : null}
        <div className="app-pick-list" aria-live="polite">
          {available.isPending ? (
            <p className="app-empty">Lade Repos von GitHub …</p>
          ) : shown.length === 0 ? (
            <p className="app-empty">
              {query ? `Kein Repo passt zu „${query}“.` : 'Der Token sieht keine Repos.'}
            </p>
          ) : (
            shown.map((r) => (
              <div className="hz-row" key={r.fullName} data-testid="available-repo">
                <div className="hz-row-main">
                  <span className="hz-row-name">{r.fullName}</span>
                  <span className="hz-row-sub">{r.private ? 'privat' : 'öffentlich'}</span>
                </div>
                <div className="hz-row-actions">
                  {r.tracked ? (
                    <Badge tone="ok">verfolgt</Badge>
                  ) : (
                    <Button
                      size="sm"
                      icon="plus"
                      disabled={add.isPending}
                      aria-label={`${r.fullName} hinzufügen`}
                      onClick={() => add.mutate(r.fullName)}
                    >
                      Hinzufügen
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
          {list.length > shown.length ? (
            <p className="app-empty">+{list.length - shown.length} weitere, Suche eingrenzen.</p>
          ) : null}
        </div>
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
