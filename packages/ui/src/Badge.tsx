import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';
import { Icon } from './Icon.js';
import type { IconName, Tone } from './types.js';

export interface BadgeProps {
  tone?: Tone | undefined;
  icon?: IconName | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

/** 1:1 port of Badge from design/reference/bundle.js. */
export function Badge({ tone, icon, children, className }: BadgeProps): ReactElement {
  return (
    <span className={cx('hz-badge', 'hz-badge-' + (tone || 'neutral'), className)}>
      {icon ? <Icon name={icon} size={10} /> : null}
      {children}
    </span>
  );
}
