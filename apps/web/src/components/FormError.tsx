import type { ReactElement } from 'react';
import { Alert } from '@hz/ui';

/** Error line under a form. Alert with tone crit has role=alert, so it is announced. */
export function FormError({ title, text }: { title: string; text?: string }): ReactElement {
  return (
    <Alert tone="crit" title={title}>
      {text}
    </Alert>
  );
}
