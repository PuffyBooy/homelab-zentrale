import { MODULES, type ModuleId, type Modules } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Tile, Toggle } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { authStateKey } from '../../lib/auth.js';
import { errorText } from '../../lib/errors.js';
import {
  MODULE_HINT,
  MODULE_LABEL,
  fetchModules,
  modulesKey,
  saveModules,
} from '../../lib/modules.js';

function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/**
 * Settings → Module (decision 2026-11-26): every optional module can be switched. Switching
 * one of MODULES_ENABLE_STEP_UP on needs step-up (api() asks).
 */
export function ModulesTile(): ReactElement {
  const qc = useQueryClient();
  const modules = useQuery({
    queryKey: modulesKey,
    queryFn: ({ signal }) => fetchModules(signal),
  });
  const save = useMutation({
    mutationFn: (body: Partial<Modules>) => saveModules(body),
    onSuccess: (next) => {
      qc.setQueryData(modulesKey, next);
      // Nav, overview and palette read the modules from the auth state.
      void qc.invalidateQueries({ queryKey: authStateKey });
    },
  });
  const m = modules.data;
  const err = shownError(save.error);

  return (
    <Tile title="Module" icon="cpu">
      <p className="app-text">
        Ausgeschaltete Module verschwinden aus Navigation und Übersicht, ihre Abfragen und Jobs
        ruhen. Daten und Einstellungen bleiben erhalten. Module mit Zugangsdaten (GitHub, Home
        Assistant, die Anbindungen) und Module, die von außen steuern (Discord-Bot,
        Sprachsteuerung), einschalten braucht einen Code.
      </p>
      {modules.isError ? <FormError title={errorText(modules.error)} /> : null}
      {m ? (
        <div className="app-rows" data-testid="modules">
          {MODULES.map((id: ModuleId) => (
            <Toggle
              key={id}
              label={MODULE_LABEL[id]}
              hint={`${m[id] ? 'an' : 'aus'} · ${MODULE_HINT[id]}`}
              checked={m[id]}
              disabled={save.isPending}
              onChange={(next) => save.mutate({ [id]: next })}
            />
          ))}
        </div>
      ) : modules.isPending ? (
        <p className="app-empty">Lade Module …</p>
      ) : null}
      {err ? <FormError title={err} /> : null}
    </Tile>
  );
}
