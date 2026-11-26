import type { ReactElement } from 'react';
import { cx } from './cx.js';
import { ICON_PATHS as PATHS } from './icon-paths.js';
import type { IconName } from './types.js';

export interface IconProps {
  name: IconName;
  size?: number | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/** All icon names in reference order (`Icon.names` in the bundle). */
export const iconNames = Object.keys(PATHS) as IconName[];

/** 1:1 port of Icon from design/reference/bundle.js. */
export function Icon({ name, size, label, className }: IconProps): ReactElement {
  const s = size || 14;
  return (
    <svg
      className={cx('hz-icon', className)}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name] ?? PATHS.alert} />
    </svg>
  );
}
Icon.names = iconNames;
