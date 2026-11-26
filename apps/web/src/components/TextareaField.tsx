import { useId, type ReactElement, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from '@hz/ui';

export interface TextareaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id'
> {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
}

/**
 * Labelled multi-line input, same markup as Field (hz-field + hz-input). For pasted
 * PEM certificates. Proposed for packages/ui together with Field (docs/QUESTIONS.md).
 */
export function TextareaField({
  label,
  hint,
  error,
  className,
  ...input
}: TextareaFieldProps): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ');
  return (
    <div className={cx('hz-field', className)}>
      <label className="hz-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        {...input}
        id={id}
        className="hz-input hz-input-mono app-textarea"
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
