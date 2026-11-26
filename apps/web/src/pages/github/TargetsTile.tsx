import type { DeployTarget, RepoSummary, ServerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Badge, Button, Tile } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import {
  DEPLOY_BLOCK_TEXT,
  MAX_BEHIND,
  createDeployKey,
  deleteTarget,
  deployBlock,
  deployKeyUrl,
  needsDeploy,
  reposKey,
  shortSha,
} from '../../lib/github.js';
import { mergeById } from '../../lib/live.js';
import { TargetDialog } from './TargetDialog.js';
import type { DeployVars } from './useDeploy.js';

export interface TargetsTileProps {
  repo: RepoSummary;
  servers: ServerSummary[];
  deploying: boolean;
  onDeploy: (vars: DeployVars) => void;
}

/** Deploy targets of a repo (SPEC 7) with deploy, edit, delete and the deploy key step. */
export function TargetsTile({
  repo,
  servers,
  deploying,
  onDeploy,
}: TargetsTileProps): ReactElement {
  const [editing, setEditing] = useState<DeployTarget | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DeployTarget | null>(null);
  const block = repo.targets[0]
    ? deployBlock(repo, { deploying: false, headSha: null, headCi: repo.ci })
    : 'ok';

  return (
    <Tile
      title="Deploy-Ziele"
      icon="server"
      count={repo.targets.length || undefined}
      span={2}
      flush
      actions={
        <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
          Ziel anlegen
        </Button>
      }
    >
      {repo.targets.length === 0 ? (
        <p className="app-empty app-pad">
          Noch kein Ziel. Leg fest, auf welchem Server und in welchem Ordner {repo.fullName} laufen
          soll.
        </p>
      ) : (
        <>
          {block !== 'ok' && block !== 'deploying' ? (
            <p className="app-text app-pad">{DEPLOY_BLOCK_TEXT[block]}</p>
          ) : null}
          {repo.targets.map((t) => (
            <TargetBlock
              key={t.id}
              repo={repo}
              target={t}
              deploying={deploying}
              onDeploy={() => onDeploy({ targetIds: [t.id] })}
              onEdit={() => setEditing(t)}
              onDelete={() => setDeleting(t)}
            />
          ))}
        </>
      )}
      {editing ? (
        <TargetDialog
          open
          onClose={() => setEditing(null)}
          repo={repo}
          servers={servers}
          target={editing === 'new' ? undefined : editing}
        />
      ) : null}
      {deleting ? (
        <DeleteTargetDialog repo={repo} target={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </Tile>
  );
}

function TargetBlock({
  repo,
  target: t,
  deploying,
  onDeploy,
  onEdit,
  onDelete,
}: {
  repo: RepoSummary;
  target: DeployTarget;
  deploying: boolean;
  onDeploy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  const ok = deployBlock(repo, t) === 'ok';
  const outdated = needsDeploy(t);
  const behind = t.behind >= MAX_BEHIND ? `${MAX_BEHIND}+` : String(t.behind);
  const sub = [
    t.path,
    t.method,
    t.autoDeploy ? 'automatisch' : null,
    t.liveSha ? `live ${shortSha(t.liveSha)}` : 'nicht deployt',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="app-target" data-testid="target">
      <div className="hz-row app-wrap-row">
        <div className="hz-row-main">
          <span className="hz-row-name">
            {t.serverName}
            <span className="hz-repo-branch">{t.branch}</span>
          </span>
          <span className="hz-row-sub">{sub}</span>
        </div>
        {t.deploying ? (
          <Badge tone="info">Deploy läuft</Badge>
        ) : t.liveSha && t.behind > 0 ? (
          <Badge tone="accent">{behind} neu</Badge>
        ) : t.liveSha ? (
          <Badge tone="ok">aktuell</Badge>
        ) : null}
        <div className="hz-row-actions">
          {ok ? (
            <Button
              size="sm"
              variant={outdated ? 'primary' : 'secondary'}
              disabled={deploying}
              onClick={onDeploy}
              aria-label={`${outdated ? 'Deploy' : 'Neu deployen'} auf ${t.serverName}`}
            >
              {outdated ? 'Deploy' : 'Neu deployen'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Ziel ${t.serverName} bearbeiten`}
          >
            Bearbeiten
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            aria-label={`Ziel ${t.serverName} löschen`}
          >
            Löschen
          </Button>
        </div>
      </div>
      <DeployKeyStep repo={repo} target={t} />
    </div>
  );
}

/**
 * Deploy key (SPEC 7): the agent creates an ed25519 key on the target server, the
 * private half never leaves it. The admin adds the public half at GitHub as read-only key.
 */
export function DeployKeyStep({
  repo,
  target: t,
}: {
  repo: RepoSummary;
  target: DeployTarget;
}): ReactElement {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => createDeployKey(t.id),
    onSuccess: (saved) => {
      qc.setQueryData<RepoSummary[]>(reposKey, (old) =>
        old?.map((r) => (r.id === repo.id ? { ...r, targets: mergeById(r.targets, [saved]) } : r)),
      );
    },
  });

  if (t.publicKey) {
    return (
      <div className="app-pad app-stack">
        <CopyBlock label={`Deploy-Key von ${t.serverName}`} text={t.publicKey} inline />
        <ol className="app-howto">
          <li>
            Bei GitHub{' '}
            <a href={deployKeyUrl(repo.fullName)} target="_blank" rel="noopener noreferrer">
              Settings → Deploy keys → Add deploy key
            </a>{' '}
            öffnen.
          </li>
          <li>Titel z. B. „homelab {t.serverName}“, den Key oben einfügen.</li>
          <li>„Allow write access“ aus lassen. Der Key darf nur lesen.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="app-pad app-stack">
      <p className="app-text">
        {repo.private
          ? `Privates Repo: ${t.serverName} braucht einen Deploy-Key, um zu klonen.`
          : 'Öffentliches Repo: Klonen geht ohne Key. Ein Deploy-Key ist optional.'}
      </p>
      {create.error ? <FormError title={errorText(create.error)} /> : null}
      <div className="hz-form-actions">
        <Button size="sm" icon="lock" disabled={create.isPending} onClick={() => create.mutate()}>
          Deploy-Key erzeugen
        </Button>
      </div>
    </div>
  );
}

function DeleteTargetDialog({
  repo,
  target,
  onClose,
}: {
  repo: RepoSummary;
  target: DeployTarget;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteTarget(target.id),
    onSuccess: () => {
      qc.setQueryData<RepoSummary[]>(reposKey, (old) =>
        old?.map((r) =>
          r.id === repo.id ? { ...r, targets: r.targets.filter((x) => x.id !== target.id) } : r,
        ),
      );
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Ziel auf ${target.serverName} löschen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          Die Zentrale deployt {repo.fullName} nicht mehr nach {target.path}. Was dort läuft, läuft
          weiter, und der Ordner bleibt auf dem Server.
        </p>
        {del.error ? <FormError title={errorText(del.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Löschen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
