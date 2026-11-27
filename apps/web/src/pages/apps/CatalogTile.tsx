import type { AppTemplateSummary } from '@hz/shared';
import { useState, type ReactElement } from 'react';
import { Badge, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { groupTemplates, templateMeta } from '../../lib/apps.js';

/** Catalog by category (APP_CATEGORY_LABELS) with a search; a card opens the install dialog. */
export function CatalogTile({
  templates,
  onPick,
}: {
  templates: readonly AppTemplateSummary[];
  onPick: (id: string) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const groups = groupTemplates(templates, query);
  return (
    <Tile
      title="Katalog"
      icon="cloud"
      count={String(templates.length)}
      span={4}
      footer={
        <span className="app-foot-text">
          Images auf Versionen gepinnt · Ports nur über die gewählte Adresse · Daten unter ./data/
        </span>
      }
    >
      <div className="hz-form">
        <Field
          label="Suchen"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="z. B. Fotos, Passwort, jellyfin"
          autoComplete="off"
          spellCheck={false}
        />
        {groups.length === 0 ? (
          <p className="app-empty" role="status">
            {templates.length
              ? `Keine Vorlage passt zu „${query.trim()}“.`
              : 'Keine Vorlagen gefunden.'}
          </p>
        ) : null}
        {groups.map((g) => (
          <section key={g.category} className="app-stack" aria-label={g.label}>
            <h3 className="hz-label app-catalog-head">{g.label}</h3>
            <div className="hz-tpl-grid">
              {g.templates.map((t) => (
                <button key={t.id} type="button" className="hz-tpl" onClick={() => onPick(t.id)}>
                  <span className="hz-tpl-name">{t.name}</span>
                  <span className="app-tpl-desc">{t.description}</span>
                  <span className="hz-tpl-meta">{templateMeta(t)}</span>
                  {t.installed || t.source === 'custom' ? (
                    <span className="hz-tpl-req">
                      {t.source === 'custom' ? <Badge tone="neutral">eigene</Badge> : <span />}
                      {t.installed ? <span>{t.installed}× installiert</span> : null}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Tile>
  );
}
