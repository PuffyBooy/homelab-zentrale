import type { ReactElement } from 'react';

/** Placeholder for nav targets that get content in later milestones. */
export function EmptyPage(): ReactElement {
  return (
    <p className="app-empty">Hier ist noch nichts. Daten kommen, sobald Agents verbunden sind.</p>
  );
}

export function NotFoundPage(): ReactElement {
  return <p className="app-empty">Diese Adresse gibt es nicht. Taste 1 führt zur Übersicht.</p>;
}
