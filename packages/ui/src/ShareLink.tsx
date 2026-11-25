import type { ReactElement } from 'react';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { copyText } from './clipboard.js';
import { cx } from './cx.js';
import { Icon } from './Icon.js';

export interface SharePerm {
  id: string;
  label: string;
  on: boolean;
}

export interface ShareLinkProps {
  server: string;
  user: string;
  url: string;
  expires: string;
  expired?: boolean | undefined;
  lastUsed?: string | undefined;
  perms: SharePerm[];
}

/** 1:1 port of ShareLink from design/reference/bundle.js. */
export function ShareLink({
  server,
  user,
  url,
  expires,
  expired,
  lastUsed,
  perms,
}: ShareLinkProps): ReactElement {
  return (
    <div className="hz-share">
      <div className="hz-share-top">
        <div>
          <div className="hz-label">{'Benutzerlink für ' + server}</div>
          <div className="hz-share-user">
            <Icon name="users" size={12} />
            {user}
          </div>
        </div>
        <Badge tone={expired ? 'crit' : 'neutral'}>{expires}</Badge>
      </div>
      <div className="hz-share-url">
        <code>{url}</code>
        <Button size="sm" icon="copy" onClick={() => copyText(url)}>
          Kopieren
        </Button>
      </div>
      <div className="hz-share-perms">
        {(perms || []).map((x) => (
          <span key={x.id} className={cx('hz-perm', x.on && 'hz-perm-on')}>
            {x.on ? '[x] ' : '[ ] '}
            {x.label}
          </span>
        ))}
      </div>
      <div className="hz-share-foot">
        <span>{lastUsed ? 'zuletzt benutzt ' + lastUsed : 'noch nie benutzt'}</span>
        <Button size="sm" variant="danger">
          Widerrufen
        </Button>
      </div>
    </div>
  );
}
