import type { Throttled } from '@hz/shared';
import type { ReactElement } from 'react';
import { Badge } from '@hz/ui';
import { AUTO_STOPPED_TEXT, throttleBadge, throttleDetail } from '../../lib/throttle.js';

/**
 * Hint in container and game lists (M10): "gedrosselt (1 Kern)" or
 * "automatisch gestoppt". Text in the badge, details in the tooltip.
 */
export function ThrottleBadge({
  throttled,
  autoStopped,
}: {
  throttled: Throttled | null;
  autoStopped: boolean;
}): ReactElement | null {
  if (throttled) {
    return (
      <span title={throttleDetail(throttled)}>
        <Badge tone="warn" icon="cpu" className="app-throttle-badge">
          {throttleBadge(throttled)}
        </Badge>
      </span>
    );
  }
  if (autoStopped) {
    return (
      <Badge tone="warn" icon="stop" className="app-throttle-badge">
        {AUTO_STOPPED_TEXT}
      </Badge>
    );
  }
  return null;
}
