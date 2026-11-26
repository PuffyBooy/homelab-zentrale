import type { TemplateField } from '@hz/shared';
import type { ReactElement } from 'react';
import { Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { SelectField } from '../../components/SelectField.js';
import { formatNumber } from '../../lib/format.js';
import type { FieldDraft } from '../../lib/games.js';

export interface TemplateFieldsProps {
  fields: readonly TemplateField[];
  draft: FieldDraft;
  /** Errors by field key. */
  errors: Readonly<Record<string, string | undefined>>;
  onChange: (key: string, value: string | boolean) => void;
  disabled?: boolean;
}

function rangeHint(min: number | undefined, max: number | undefined): string | undefined {
  const n = (v: number): string => formatNumber(v, 6);
  if (min != null && max != null) return `${n(min)} bis ${n(max)}`;
  if (min != null) return `ab ${n(min)}`;
  if (max != null) return `bis ${n(max)}`;
  return undefined;
}

/**
 * Form generated from template.json `fields` (SPEC 6.2): text, number, select and
 * boolean. Same generator for "Aufsetzen" and the settings of a game.
 */
export function TemplateFields({
  fields,
  draft,
  errors,
  onChange,
  disabled,
}: TemplateFieldsProps): ReactElement | null {
  if (fields.length === 0) return null;
  return (
    <div className="app-fields">
      {fields.map((f) => {
        const err = errors[f.key];
        switch (f.type) {
          case 'boolean':
            return (
              <div key={f.key} className="app-fields-wide">
                <Toggle
                  label={f.label}
                  checked={draft[f.key] === true}
                  disabled={disabled}
                  onChange={(v) => onChange(f.key, v)}
                />
              </div>
            );
          case 'select':
            return (
              <SelectField
                key={f.key}
                label={f.label}
                value={String(draft[f.key] ?? f.default)}
                options={f.options.map((o) => ({ value: o, label: o }))}
                onChange={(e) => onChange(f.key, e.target.value)}
                error={err}
                disabled={disabled}
                name={f.key}
              />
            );
          case 'number':
            return (
              <Field
                key={f.key}
                label={f.label}
                mono
                inputMode="decimal"
                value={String(draft[f.key] ?? '')}
                onChange={(e) => onChange(f.key, e.target.value)}
                hint={
                  [rangeHint(f.min, f.max), f.optional ? 'optional' : null]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                error={err}
                disabled={disabled}
                autoComplete="off"
                name={f.key}
              />
            );
          case 'text':
            return (
              <Field
                key={f.key}
                label={f.label}
                mono
                type={f.secret ? 'password' : 'text'}
                value={String(draft[f.key] ?? '')}
                onChange={(e) => onChange(f.key, e.target.value)}
                hint={f.optional ? 'optional' : undefined}
                error={err}
                disabled={disabled}
                maxLength={200}
                autoComplete={f.secret ? 'new-password' : 'off'}
                autoCapitalize="none"
                spellCheck={false}
                name={f.key}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
