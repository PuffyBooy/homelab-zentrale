import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { cx } from './cx.js';
import { Icon } from './Icon.js';
import type { IconName } from './types.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | undefined;
  size?: 'sm' | 'md' | undefined;
  icon?: IconName | undefined;
}

/** 1:1 port of Button from design/reference/bundle.js. */
export function Button({
  variant,
  size,
  icon,
  children,
  className,
  type,
  ...rest
}: ButtonProps): ReactElement {
  const v = variant || 'secondary';
  const s = size || 'md';
  return (
    <button
      {...rest}
      className={cx(
        'hz-btn',
        'hz-btn-' + v,
        'hz-btn-' + s,
        !children && 'hz-btn-iconly',
        className,
      )}
      type={type || 'button'}
    >
      {icon ? <Icon name={icon} size={s === 'sm' ? 12 : 14} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
