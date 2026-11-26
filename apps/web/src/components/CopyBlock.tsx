import { useEffect, useId, useState, type ReactElement } from 'react';
import { Button, cx } from '@hz/ui';

/** Copies text; resolves false when the Clipboard API is missing or refused. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyBlockProps {
  label: string;
  text: string;
  /** Single line (token) instead of a code block. */
  inline?: boolean;
  className?: string;
}

/**
 * Labelled, selectable code with a copy button. Proposed for packages/ui as `CopyBlock`
 * (docs/QUESTIONS.md). The text stays selectable, so copying also works without the API.
 */
export function CopyBlock({ label, text, inline, className }: CopyBlockProps): ReactElement {
  const id = useId();
  const [copied, setCopied] = useState<null | boolean>(null);

  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className={cx('app-copy', className)}>
      <div className="app-copy-head">
        <span className="hz-label" id={id}>
          {label}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          aria-describedby={id}
          onClick={() => void copyToClipboard(text).then(setCopied)}
        >
          {copied === true ? 'Kopiert' : copied === false ? 'Markieren und kopieren' : 'Kopieren'}
        </Button>
      </div>
      {inline ? (
        <code className="app-copy-code app-copy-inline" aria-labelledby={id}>
          {text}
        </code>
      ) : (
        <pre className="app-copy-code" aria-labelledby={id} tabIndex={0}>
          {text}
        </pre>
      )}
    </div>
  );
}
