import type { ReactElement } from 'react';
import { cx } from './cx.js';
import { StatusDot } from './StatusDot.js';
import type { IconName, Status } from './types.js';

export interface ServerEntry {
  id: string;
  name: string;
  where?: string | undefined;
  status?: Status | undefined;
  icon?: IconName | undefined;
}

export interface ServerSwitchProps {
  servers: ServerEntry[];
  active?: string | undefined;
  onChange?: ((id: string) => void) | undefined;
}

/** 1:1 port of ServerSwitch from design/reference/bundle.js. The entry with id `all` has no dot. */
export function ServerSwitch({ servers, active, onChange }: ServerSwitchProps): ReactElement {
  return (
    <div className="hz-servers" role="tablist" aria-label="Server">
      {(servers || []).map((s) => {
        const on = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={cx('hz-server', on && 'hz-server-on')}
            onClick={() => onChange?.(s.id)}
          >
            {s.id === 'all' ? null : <StatusDot status={s.status || 'ok'} hideLabel={true} />}
            <span>{s.name}</span>
          </button>
        );
      })}
    </div>
  );
}
