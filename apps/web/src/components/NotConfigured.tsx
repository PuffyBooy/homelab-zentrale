import type { IntegrationId } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Tile, type IconName } from '@hz/ui';

export interface NotConfiguredProps {
  integration: IntegrationId;
  title: string;
  icon: IconName;
  /** What appears here once it is set up. */
  text: string;
  span?: 2 | 4;
}

/** Empty state of a module that is on but has no URL or secret yet. */
export function NotConfigured({
  integration,
  title,
  icon,
  text,
  span,
}: NotConfiguredProps): ReactElement {
  return (
    <Tile title={title} icon={icon} status="off" statusLabel="nicht eingerichtet" span={span}>
      <div className="app-empty-block" data-testid={`not-configured-${integration}`}>
        <p className="app-empty">{text}</p>
        <div>
          <Link
            className="hz-btn hz-btn-secondary hz-btn-sm"
            to={`/settings#anbindung-${integration}`}
          >
            <span>Einstellungen → Anbindungen</span>
          </Link>
        </div>
      </div>
    </Tile>
  );
}
