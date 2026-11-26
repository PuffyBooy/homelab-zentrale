import { useState, type ReactElement } from 'react';
import { Button } from '@hz/ui';

/** The 10 recovery codes, numbered, with a copy button. */
export function RecoveryCodes({ codes }: { codes: string[] }): ReactElement {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  return (
    <div className="hz-form">
      <ol className="app-codes" aria-label="Wiederherstellungscodes" data-testid="recovery-codes">
        {codes.map((c, i) => (
          <li key={c}>
            <span className="app-codes-n" aria-hidden={true}>
              {i + 1}
            </span>
            <span>{c}</span>
          </li>
        ))}
      </ol>
      <div className="hz-form-actions">
        <span className="hz-field-hint" role="status">
          {copied === 'ok'
            ? 'In die Zwischenablage kopiert.'
            : copied === 'fail'
              ? 'Kopieren nicht möglich. Codes abschreiben.'
              : ''}
        </span>
        <Button icon="copy" onClick={() => void copy()}>
          Kopieren
        </Button>
      </div>
    </div>
  );
}
