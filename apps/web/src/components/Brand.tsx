import type { ReactElement } from 'react';

/** The mark from design/assets/Logos as CSS (hz-mark), plus the product name. */
export function Brand(): ReactElement {
  return (
    <div className="app-brand">
      <span className="hz-mark" aria-hidden={true}>
        <span />
      </span>
      <span>homelab</span>
    </div>
  );
}
