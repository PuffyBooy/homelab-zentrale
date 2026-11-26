import { describe, expect, it } from 'vitest';
import { ServerList } from './ServerList.js';
import type { ServerInfo } from './ServerList.js';
import { countClass, html } from './test-utils.js';

const servers: ServerInfo[] = [
  {
    id: 'home',
    name: 'heimserver',
    where: 'Wien',
    ip: '192.168.1.20',
    status: 'ok',
    cpu: 23,
    ram: 48,
    disk: 81,
    uptime: '41d',
  },
  { id: 'oci', name: 'oracle-a1', where: 'Frankfurt', status: 'warn', cpu: 64, ram: 92, disk: 37 },
  { id: 'vps', name: 'web-vps', where: 'Nürnberg', status: 'crit', note: 'kein Ping seit 23:02' },
];

describe('ServerList', () => {
  const out = html(<ServerList servers={servers} active="home" />);

  it('is a list with a header and one listitem button per server', () => {
    expect(out).toContain('class="hz-srvlist" role="list"');
    expect(out).toContain('class="hz-srvlist-head hz-label"');
    expect(out.match(/role="listitem"/g)).toHaveLength(3);
    expect(out).toContain('class="hz-srv hz-srv-on"');
    expect(out).toContain('class="hz-srv hz-srv-crit"');
  });

  it('shows where and ip, values and meters', () => {
    expect(out).toContain('<b>heimserver</b><small>Wien · 192.168.1.20</small>');
    expect(out).toContain('<i>23%</i>');
    expect(out).toContain('aria-label="Disk"');
    expect(countClass(out, 'hz-blocks-crit')).toBe(1);
    expect(countClass(out, 'hz-blocks-warn')).toBe(1);
  });

  it('reads the status long form and replaces values when down', () => {
    expect(out).toContain('<span class="hz-sr">Läuft</span>');
    expect(out).toContain('<span class="hz-sr">Ausgefallen</span>');
    expect(out).toContain('<span class="hz-srv-down">kein Ping seit 23:02</span>');
  });

  it('falls back to "nicht erreichbar" and a dash for missing values', () => {
    const o = html(
      <ServerList
        servers={[
          { id: 'a', name: 'a', where: 'x', status: 'crit' },
          { id: 'b', name: 'b', where: 'y' },
        ]}
      />,
    );
    expect(o).toContain('>nicht erreichbar<');
    expect(o).toContain('<i>—</i>');
    expect(o).not.toContain('undefined');
  });
});
