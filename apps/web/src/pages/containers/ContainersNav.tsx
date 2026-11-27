import type { ReactElement } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';

/** Areas of the container page (M23): the containers and the Docker resources. */
export const CONTAINER_AREAS: readonly { to: string; label: string }[] = [
  { to: '/containers', label: 'Container' },
  { to: '/containers/docker', label: 'Images, Volumes, Netzwerke' },
];

/** Same look as the section links of a server; the current area is marked with aria-current. */
export function ContainersNav(): ReactElement {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const server = params.get('server');
  const query = server ? `?server=${encodeURIComponent(server)}` : '';
  return (
    <nav className="app-settings-nav" aria-label="Bereiche der Container">
      {CONTAINER_AREAS.map((a) => {
        const current = pathname.replace(/\/$/, '') === a.to;
        return (
          <Link
            key={a.to}
            to={`${a.to}${query}`}
            className="app-settings-link"
            aria-current={current ? 'page' : undefined}
          >
            {a.label}
          </Link>
        );
      })}
    </nav>
  );
}
