import { useState, type ReactElement } from 'react';
import { FormError } from '../../components/FormError.js';
import { useApps, useAppTemplates } from '../../lib/apps.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { CatalogTile } from './CatalogTile.js';
import { InstallDialog } from './InstallDialog.js';
import { InstalledAppsTile } from './InstalledAppsTile.js';
import { TemplatesTile } from './TemplatesTile.js';

/**
 * /apps "Apps" (M21, module apps): installed apps first (problems on top), then the
 * catalog by category and the own templates.
 */
export function AppsPage(): ReactElement {
  const apps = useApps();
  const templates = useAppTemplates();
  const servers = useServers();
  const [installing, setInstalling] = useState<string | null>(null);
  const error = apps.error ?? templates.error;
  return (
    <div className="hz-grid app-grid">
      {error && !(apps.data && templates.data) ? <FormError title={errorText(error)} /> : null}
      {apps.data ? <InstalledAppsTile apps={apps.data} /> : null}
      {templates.data ? <CatalogTile templates={templates.data} onPick={setInstalling} /> : null}
      {templates.data ? <TemplatesTile templates={templates.data} /> : null}
      {installing ? (
        <InstallDialog
          templateId={installing}
          servers={servers.data ?? []}
          apps={apps.data ?? []}
          onClose={() => setInstalling(null)}
        />
      ) : null}
    </div>
  );
}
