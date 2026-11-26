import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cx } from '@hz/ui';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  mono?: boolean;
}

/** Labelled text input. Proposed for packages/ui as `Field` (docs/QUESTIONS.md). */
export function Field({ label, hint, error, mono, className, ...input }: FieldProps): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('hz-field', className)}>
      <label className="hz-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={cx('hz-input', mono && 'hz-input-mono')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
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
