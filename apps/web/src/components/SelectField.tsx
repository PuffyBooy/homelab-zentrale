import { useId, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '@hz/ui';

export interface SelectOption {
  value: string;
  label: string;
  /** Shown but not selectable (e.g. a server with the wrong CPU architecture). */
  disabled?: boolean | undefined;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  options: readonly SelectOption[];
  hint?: ReactNode;
  error?: string | null | undefined;
}

/**
 * Labelled native <select>, same markup as Field (hz-field + hz-input + hz-select).
 * Proposed for packages/ui together with Field (docs/QUESTIONS.md).
 */
export function SelectField({
  label,
  options,
  hint,
  error,
  className,
  ...select
}: SelectFieldProps): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('hz-field', className)}>
      <label className="hz-field-label" htmlFor={id}>
        {label}
      </label>
      <select
        {...select}
        id={id}
        className="hz-input hz-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="hz-field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="hz-field-error" id={errId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
