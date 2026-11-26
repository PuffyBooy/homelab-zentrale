import type { ReactElement } from 'react';
import { cx } from './cx.js';
import type { IconName } from './types.js';

export interface ToggleProps {
  label: string;
  hint?: string | undefined;
  /** Accepted for API parity with the reference; the reference does not render it. */
  icon?: IconName | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
  onChange?: ((next: boolean) => void) | undefined;
}

/** 1:1 port of Toggle from design/reference/bundle.js. */
export function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps): ReactElement {
  const on = !!checked;
  return (
    <div className={cx('hz-toggle', disabled && 'hz-toggle-disabled')}>
      <span className="hz-toggle-text">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        className={cx('hz-switch', on && 'hz-switch-on')}
        onClick={() => onChange?.(!on)}
      >
        <span className={cx('hz-switch-opt', !on && 'hz-switch-sel')}>AUS</span>
        <span className={cx('hz-switch-opt', on && 'hz-switch-sel')}>AN</span>
      </button>
    </div>
  );
}
