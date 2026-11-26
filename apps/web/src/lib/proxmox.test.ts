import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, guest, guests, json, mockFetch } from '../test-m14.js';
import { configureApi } from './api.js';
import {
  confirmText,
  fetchProxmoxGuests,
  guestActionPath,
  guestCpuText,
  guestRamText,
  guestStatus,
  guestStatusText,
  needsConfirm,
  proxmoxSentence,
  runGuestAction,
  sortGuests,
} from './proxmox.js';

let reset: (() => void) | undefined;
afterEach(() => {
  reset?.();
  reset = undefined;
  vi.unstubAllGlobals();
});

describe('proxmox', () => {
  it('maps guest states to shape and text', () => {
    expect(guestStatus(guest())).toBe('ok');
    expect(guestStatus(guest({ status: 'stopped' }))).toBe('off');
    expect(guestStatus(guest({ status: 'paused' }))).toBe('warn');
    expect(guestStatus(guest({ status: 'stopped', template: true }))).toBe('off');
    expect(guestStatusText(guest({ status: 'stopped', template: true }))).toBe('Vorlage');
    expect(guestStatusText(guest({ status: 'paused' }))).toBe('pausiert');
  });

  it('formats CPU and RAM in Austrian format', () => {
    expect(guestCpuText(guest())).toBe('12 % · 4 Kerne');
    expect(guestRamText(guest())).toBe('2 / 8 GB');
    expect(guestRamText(guest({ memBytes: 1.5 * 1024 ** 3 }))).toBe('1,5 / 8 GB');
    expect(guestRamText(guest({ maxMemBytes: null }))).toBe('—');
  });

  it('sorts problems first, then running, stopped, templates last', () => {
    const list = sortGuests([
      guest({ name: 'tpl', vmid: 900, status: 'stopped', template: true }),
      guest({ name: 'db', vmid: 102, status: 'stopped' }),
      guest({ name: 'web', vmid: 101 }),
      guest({ name: 'old', vmid: 103, status: 'paused' }),
    ]);
    expect(list.map((g) => g.name)).toEqual(['old', 'web', 'db', 'tpl']);
  });

  it('puts problems first in the Statussatz', () => {
    expect(proxmoxSentence(guests([guest(), guest({ vmid: 102, name: 'db' })]))).toEqual({
      em: null,
      rest: 'Alle 2 Gäste laufen.',
    });
    expect(
      proxmoxSentence(guests([guest(), guest({ vmid: 102, name: 'db', status: 'stopped' })])),
    ).toEqual({ em: null, rest: '1 von 2 Gästen läuft.' });
    expect(
      proxmoxSentence(guests([guest(), guest({ vmid: 102, name: 'old', status: 'paused' })])),
    ).toEqual({ em: 'old ist pausiert', rest: ' · 1 von 2 Gästen läuft' });
    expect(proxmoxSentence(guests([guest()], { error: 'Zeitüberschreitung' }))).toEqual({
      em: 'Proxmox nicht erreichbar: Zeitüberschreitung',
      rest: '',
    });
    const offline = guests([guest()], {
      nodes: [{ node: 'pve2', online: false, cpu: null, memBytes: null, maxMemBytes: null }],
    });
    expect(proxmoxSentence(offline).em).toBe('Knoten pve2 ist offline');
    // Templates are not guests.
    expect(proxmoxSentence(guests([guest({ status: 'stopped', template: true })])).rest).toBe(
      'Keine VMs oder Container auf Proxmox.',
    );
  });

  it('starts directly, confirms the rest', () => {
    expect(needsConfirm('start')).toBe(false);
    expect(needsConfirm('shutdown')).toBe(true);
    expect(needsConfirm('stop')).toBe(true);
    expect(needsConfirm('reboot')).toBe(true);
    expect(confirmText(guest(), 'stop')).toMatch(/hart ausgeschaltet/);
    expect(guestActionPath(guest({ node: 'pve', type: 'lxc', vmid: 200 }), 'reboot')).toBe(
      '/api/proxmox/guests/pve/lxc/200/reboot',
    );
  });

  it('sends confirm:true with stop and keeps it on the step-up retry', async () => {
    const onStepUp = vi.fn(() => Promise.resolve(true));
    reset = configureApi({ onStepUp });
    const fetchMock = mockFetch(
      json(403, { ok: false, error: 'step_up_required' }),
      json(200, { ok: true, task: 'UPID:pve:0001' }),
    );
    await expect(runGuestAction(guest(), 'stop')).resolves.toEqual({
      ok: true,
      task: 'UPID:pve:0001',
    });
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0)).toEqual({ confirm: true });
    expect(bodyOf(fetchMock, 1)).toEqual({ confirm: true });
  });

  it('sends start without confirm', async () => {
    const fetchMock = mockFetch(json(200, { ok: true, task: null }));
    await runGuestAction(guest({ status: 'stopped' }), 'start');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/proxmox/guests/pve/qemu/101/start');
    expect(bodyOf(fetchMock)).toEqual({});
  });

  it('parses the guest list with the shared schema', async () => {
    mockFetch(json(200, guests([guest()])));
    const r = await fetchProxmoxGuests();
    expect(r.guests[0]?.name).toBe('web01');
    mockFetch(json(200, { ...guests([guest()]), extra: 1 }));
    await expect(fetchProxmoxGuests()).rejects.toMatchObject({ error: 'bad_response' });
  });
});
