/* @ds-bundle: {"format":4,"namespace":"HZ","components":[{"name":"Icon"},{"name":"Button"},{"name":"StatusDot"},{"name":"Badge"},{"name":"Tile"},{"name":"Metric"},{"name":"UsageBar"},{"name":"Sparkline"},{"name":"ServerList"},{"name":"ServiceRow"},{"name":"WebCheckRow"},{"name":"RepoRow"},{"name":"CommitRow"},{"name":"GameServer"},{"name":"GameTemplates"},{"name":"ShareLink"},{"name":"Toggle"},{"name":"Alert"},{"name":"Terminal"},{"name":"NavRail"},{"name":"ServerSwitch"}]} */
(function () {
  var React = window.React, h = React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }
  function pick(p, skip) { var o = {}; for (var k in p) if (skip.indexOf(k) < 0) o[k] = p[k]; return o; }

  var PATHS = {
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    container: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
    git: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
    power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
    terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
    refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
    cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
    thermo: 'M14 14V5a2 2 0 1 0-4 0v9a4 4 0 1 0 4 0z',
    plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
    lock: 'M6 11h12v10H6zM8 11V8a4 4 0 1 1 8 0v3',
    wifi: 'M2 9a15 15 0 0 1 20 0M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M12 20h.01',
    play: 'M7 4l13 8-13 8z',
    stop: 'M6 6h12v12H6z',
    check: 'M4 12l5 5L20 6',
    alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
    door: 'M6 3h12v18H6zM14 12h.01',
    cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z',
    gamepad: 'M6 9h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-1a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M16 12h.01M18 13h.01',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
    plus: 'M12 5v14M5 12h14'
  };
  function Icon(p) {
    var size = p.size || 14;
    return h('svg', { className: cx('hz-icon', p.className), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': p.label ? undefined : true, role: p.label ? 'img' : undefined, 'aria-label': p.label },
      h('path', { d: PATHS[p.name] || PATHS.alert }));
  }
  Icon.names = Object.keys(PATHS);

  function Button(p) {
    var v = p.variant || 'secondary', s = p.size || 'md';
    var rest = pick(p, ['variant', 'size', 'icon', 'children', 'className']);
    rest.className = cx('hz-btn', 'hz-btn-' + v, 'hz-btn-' + s, !p.children && 'hz-btn-iconly', p.className);
    rest.type = p.type || 'button';
    return h('button', rest, p.icon ? h(Icon, { name: p.icon, size: s === 'sm' ? 12 : 14 }) : null, p.children ? h('span', null, p.children) : null);
  }

  var TAG = { ok: 'UP', warn: 'WARN', crit: 'DOWN', off: 'OFF', info: 'INFO', busy: 'BOOT' };
  var LONG = { ok: 'Läuft', warn: 'Warnung', crit: 'Ausgefallen', off: 'Gestoppt', info: 'Info', busy: 'Startet' };
  function StatusDot(p) {
    var s = p.status || 'ok';
    return h('span', { className: cx('hz-status', 'hz-status-' + s, p.className), title: p.label || LONG[s] },
      h('span', { className: cx('hz-dot', (s === 'crit' || s === 'busy') && p.pulse !== false && 'hz-dot-pulse'), 'aria-hidden': true }),
      p.hideLabel ? h('span', { className: 'hz-sr' }, p.label || LONG[s]) : h('span', { className: 'hz-status-label' }, p.label || TAG[s]));
  }

  function Badge(p) {
    return h('span', { className: cx('hz-badge', 'hz-badge-' + (p.tone || 'neutral'), p.className) }, p.icon ? h(Icon, { name: p.icon, size: 10 }) : null, p.children);
  }

  function Tile(p) {
    return h('section', { className: cx('hz-tile', p.span && 'hz-span-' + p.span, p.status === 'crit' && 'hz-tile-crit', p.flush && 'hz-tile-flush', p.className) },
      (p.title || p.status || p.actions) ? h('header', { className: 'hz-tile-head' },
        h('div', { className: 'hz-tile-title' }, p.icon ? h(Icon, { name: p.icon, size: 12 }) : null, h('span', null, p.title), p.count != null ? h('span', { className: 'hz-tile-count' }, p.count) : null),
        h('div', { className: 'hz-tile-meta' }, p.status ? h(StatusDot, { status: p.status, label: p.statusLabel }) : null, p.actions || null)) : null,
      h('div', { className: 'hz-tile-body' }, p.children),
      p.footer ? h('footer', { className: 'hz-tile-foot' }, p.footer) : null);
  }

  function Metric(p) {
    var d = p.delta;
    return h('div', { className: cx('hz-metric', p.size === 'wall' && 'hz-metric-wall', p.className) },
      h('div', { className: 'hz-label' }, p.label),
      h('div', { className: 'hz-metric-value' }, h('span', { className: 'hz-num' }, p.value), p.unit ? h('span', { className: 'hz-unit' }, p.unit) : null),
      (d || p.hint) ? h('div', { className: 'hz-metric-hint' },
        d ? h('span', { className: cx('hz-delta', p.deltaTone && 'hz-delta-' + p.deltaTone) }, d) : null,
        p.hint ? h('span', null, p.hint) : null) : null);
  }

  function toneOf(v, warn, crit) { return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok'; }
  function BlockBar(p) {
    var cells = p.cells || 10, v = Math.max(0, Math.min(100, p.value || 0)), n = Math.round(v / 100 * cells);
    var tone = toneOf(v, p.warnAt == null ? 75 : p.warnAt, p.critAt == null ? 90 : p.critAt);
    var cs = []; for (var i = 0; i < cells; i++) cs.push(h('i', { key: i, className: i < n ? 'hz-cell-on' : null }));
    return h('span', { className: 'hz-blocks hz-blocks-' + tone, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': v, 'aria-label': p.label }, cs);
  }

  function UsageBar(p) {
    var v = Math.max(0, Math.min(100, p.value || 0));
    return h('div', { className: 'hz-usage' },
      h('span', { className: 'hz-usage-label' }, p.label),
      h(BlockBar, { value: v, cells: p.cells || 20, warnAt: p.warnAt, critAt: p.critAt, label: p.label }),
      h('span', { className: 'hz-usage-val' }, p.detail || (Math.round(v) + '%')));
  }

  function Sparkline(p) {
    var d = p.data || [], w = p.width || 120, ht = p.height || 24;
    if (d.length < 2) return null;
    var mn = Math.min.apply(null, d), mx = Math.max.apply(null, d), r = mx - mn || 1, bw = w / d.length;
    return h('svg', { className: cx('hz-spark', 'hz-spark-' + (p.tone || 'accent')), width: w, height: ht, viewBox: '0 0 ' + w + ' ' + ht, 'aria-hidden': true },
      d.map(function (v, i) { var bh = 2 + ((v - mn) / r) * (ht - 2); return h('rect', { key: i, x: i * bw, y: ht - bh, width: Math.max(1, bw - 1), height: bh, className: i === d.length - 1 ? 'hz-spark-last' : 'hz-spark-bar' }); }));
  }

  function ServerList(p) {
    return h('div', { className: 'hz-srvlist', role: 'list' },
      h('div', { className: 'hz-srvlist-head hz-label' }, h('span', null, 'Server'), h('span', null, 'CPU'), h('span', null, 'RAM'), h('span', null, 'Disk'), h('span', null, 'Up')),
      (p.servers || []).map(function (s) {
        var on = s.id === p.active;
        return h('button', { key: s.id, type: 'button', role: 'listitem', className: cx('hz-srv', on && 'hz-srv-on', s.status === 'crit' && 'hz-srv-crit'), onClick: function () { p.onSelect && p.onSelect(s.id); } },
          h('span', { className: 'hz-srv-name' }, h(StatusDot, { status: s.status || 'ok', hideLabel: true }), h('span', null, h('b', null, s.name), h('small', null, s.where + (s.ip ? ' · ' + s.ip : '')))),
          s.status === 'crit' ? h('span', { className: 'hz-srv-down' }, s.note || 'nicht erreichbar') : [
            h('span', { key: 'c', className: 'hz-srv-cell' }, h(BlockBar, { value: s.cpu, cells: 6, label: 'CPU' }), h('i', null, s.cpu + '%')),
            h('span', { key: 'r', className: 'hz-srv-cell' }, h(BlockBar, { value: s.ram, cells: 6, label: 'RAM' }), h('i', null, s.ram + '%')),
            h('span', { key: 'd', className: 'hz-srv-cell' }, h(BlockBar, { value: s.disk, cells: 6, label: 'Disk' }), h('i', null, s.disk + '%')),
            h('span', { key: 'u', className: 'hz-srv-up' }, s.uptime)]);
      }));
  }

  function ServiceRow(p) {
    return h('div', { className: 'hz-row' },
      h(StatusDot, { status: p.status || 'ok' }),
      h('div', { className: 'hz-row-main' },
        h('span', { className: 'hz-row-name' }, p.name),
        h('span', { className: 'hz-row-sub' }, p.host)),
      p.meta ? h('div', { className: 'hz-row-meta' }, p.meta) : null,
      p.actions ? h('div', { className: 'hz-row-actions' }, p.actions) : null);
  }

  function WebCheckRow(p) {
    var ssl = p.sslDays;
    return h('div', { className: 'hz-row hz-web' },
      h(StatusDot, { status: p.status || 'ok' }),
      h('div', { className: 'hz-row-main' }, h('span', { className: 'hz-row-name' }, p.url), p.host ? h('span', { className: 'hz-row-sub' }, p.host) : null),
      h('span', { className: cx('hz-web-code', p.code >= 400 && 'hz-t-crit') }, p.code || '---'),
      h('span', { className: cx('hz-web-ms', p.ms > 800 && 'hz-t-warn') }, p.ms != null ? p.ms + ' ms' : '—'),
      h('span', { className: cx('hz-web-ssl', ssl != null && ssl < 14 && (ssl < 5 ? 'hz-t-crit' : 'hz-t-warn')) }, ssl != null ? 'SSL ' + ssl + 'd' : 'SSL —'),
      p.actions ? h('div', { className: 'hz-row-actions' }, p.actions) : null);
  }

  function RepoRow(p) {
    return h('div', { className: 'hz-row hz-repo' },
      h(Icon, { name: 'git', size: 14 }),
      h('div', { className: 'hz-row-main' },
        h('span', { className: 'hz-row-name' }, p.repo, h('span', { className: 'hz-repo-branch' }, p.branch || 'main')),
        h('span', { className: 'hz-row-sub' }, p.commit, h('span', { className: 'hz-repo-target' }, p.deployedTo ? ' → ' + p.deployedTo : ' · nicht deployt'))),
      h(StatusDot, { status: p.ci || 'ok', label: { ok: 'CI ✓', crit: 'CI ✗', busy: 'CI …', off: 'kein CI' }[p.ci || 'ok'] }),
      p.behind ? h(Badge, { tone: 'accent' }, p.behind + ' neu') : p.deployedTo ? h(Badge, { tone: 'ok' }, 'aktuell') : null,
      p.action || null);
  }

  function CommitRow(p) {
    return h('div', { className: 'hz-row hz-commit' },
      h('code', { className: 'hz-hash' }, (p.hash || '').slice(0, 7)),
      h('div', { className: 'hz-row-main' },
        h('span', { className: 'hz-row-name' }, p.message),
        h('span', { className: 'hz-row-sub' }, p.repo + '/' + (p.branch || 'main') + ' · ' + p.time)),
      h(StatusDot, { status: p.status || 'ok', label: p.statusLabel }),
      p.live ? h(Badge, { tone: 'accent' }, 'LIVE') : (p.action || null));
  }

  function copyText(t) { try { navigator.clipboard && navigator.clipboard.writeText(t); } catch (e) {} }

  function GameServer(p) {
    var pl = p.players || [0, 0];
    return h('section', { className: cx('hz-tile hz-game', p.status === 'crit' && 'hz-tile-crit') },
      h('header', { className: 'hz-tile-head' },
        h('div', { className: 'hz-tile-title' }, h(Icon, { name: 'gamepad', size: 12 }), h('span', null, p.name)),
        h(StatusDot, { status: p.status || 'ok' })),
      h('div', { className: 'hz-game-body' },
        h('div', { className: 'hz-game-top' },
          h('div', null, h('div', { className: 'hz-label' }, p.game + (p.version ? ' · ' + p.version : '')),
            h('button', { type: 'button', className: 'hz-addr', onClick: function () { copyText(p.address); }, title: 'Adresse kopieren' }, h('span', null, p.address), h(Icon, { name: 'copy', size: 12 }))),
          h('div', { className: 'hz-game-players' }, h('span', { className: 'hz-num' }, pl[0]), h('span', { className: 'hz-unit' }, '/' + pl[1]), h('div', { className: 'hz-label' }, 'Spieler'))),
        h('div', { className: 'hz-game-stats' },
          h(UsageBar, { label: 'RAM', value: p.ram || 0, cells: 12, detail: p.ramDetail }),
          h(UsageBar, { label: 'TPS', value: p.tps != null ? p.tps / 20 * 100 : 0, cells: 12, warnAt: 101, critAt: 101, detail: p.tps != null ? String(p.tps) : '—' })),
        p.online && p.online.length ? h('div', { className: 'hz-game-online' }, p.online.map(function (n) { return h('span', { key: n }, n); })) : null),
      h('footer', { className: 'hz-game-actions' },
        p.status === 'off' ? h(Button, { size: 'sm', variant: 'primary', icon: 'play' }, 'Start') : h(Button, { size: 'sm', icon: 'stop' }, 'Stop'),
        h(Button, { size: 'sm', icon: 'refresh' }, 'Restart'),
        h(Button, { size: 'sm', icon: 'terminal' }, 'Konsole'),
        h(Button, { size: 'sm', variant: 'ghost', icon: 'link' }, 'Teilen'),
        h('span', { className: 'hz-game-host' }, p.host)));
  }

  function GameTemplates(p) {
    return h('div', { className: 'hz-tpl-grid' }, (p.templates || []).map(function (t) {
      return h('button', { key: t.id, type: 'button', className: cx('hz-tpl', t.id === p.selected && 'hz-tpl-on'), onClick: function () { p.onPick && p.onPick(t.id); } },
        h('span', { className: 'hz-tpl-name' }, t.name),
        h('span', { className: 'hz-tpl-meta' }, t.image),
        h('span', { className: 'hz-tpl-req' }, h('span', null, 'RAM ' + t.ram), h('span', null, ':' + t.port)),
        t.fits === false ? h('span', { className: 'hz-tpl-warn' }, 'zu wenig RAM frei') : null);
    }));
  }

  function ShareLink(p) {
    var perms = p.perms || [];
    return h('div', { className: 'hz-share' },
      h('div', { className: 'hz-share-top' },
        h('div', null, h('div', { className: 'hz-label' }, 'Benutzerlink für ' + p.server), h('div', { className: 'hz-share-user' }, h(Icon, { name: 'users', size: 12 }), p.user)),
        h(Badge, { tone: p.expired ? 'crit' : 'neutral' }, p.expires)),
      h('div', { className: 'hz-share-url' }, h('code', null, p.url), h(Button, { size: 'sm', icon: 'copy', onClick: function () { copyText(p.url); } }, 'Kopieren')),
      h('div', { className: 'hz-share-perms' }, perms.map(function (x) {
        return h('span', { key: x.id, className: cx('hz-perm', x.on && 'hz-perm-on') }, x.on ? '[x] ' : '[ ] ', x.label);
      })),
      h('div', { className: 'hz-share-foot' }, h('span', null, p.lastUsed ? 'zuletzt benutzt ' + p.lastUsed : 'noch nie benutzt'), h(Button, { size: 'sm', variant: 'danger' }, 'Widerrufen')));
  }

  function Toggle(p) {
    var on = !!p.checked;
    return h('div', { className: cx('hz-toggle', p.disabled && 'hz-toggle-disabled') },
      h('span', { className: 'hz-toggle-text' }, p.label, p.hint ? h('small', null, p.hint) : null),
      h('button', { type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': p.label, disabled: p.disabled, className: cx('hz-switch', on && 'hz-switch-on'), onClick: function () { p.onChange && p.onChange(!on); } },
        h('span', { className: cx('hz-switch-opt', !on && 'hz-switch-sel') }, 'AUS'), h('span', { className: cx('hz-switch-opt', on && 'hz-switch-sel') }, 'AN')));
  }

  function Alert(p) {
    var t = p.tone || 'info';
    var lvl = { ok: 'OK', warn: 'WARN', crit: 'CRIT', info: 'INFO' }[t];
    return h('div', { className: cx('hz-alert', 'hz-alert-' + t, p.floating && 'hz-alert-floating'), role: t === 'crit' ? 'alert' : 'status' },
      p.time ? h('span', { className: 'hz-alert-time' }, p.time) : null,
      h('span', { className: 'hz-alert-lvl' }, lvl),
      h('div', { className: 'hz-alert-main' }, h('span', { className: 'hz-alert-title' }, p.title), p.children ? h('span', { className: 'hz-alert-body' }, p.children) : null),
      p.action || null);
  }

  function Terminal(p) {
    var lines = p.lines || [];
    return h('div', { className: 'hz-term' },
      h('div', { className: 'hz-term-head' }, h('span', null, p.title || 'konsole'), p.host ? h('span', { className: 'hz-term-host' }, p.host) : null),
      h('pre', { className: 'hz-term-body', style: p.height ? { height: p.height } : null }, lines.map(function (l, i) {
        var o = typeof l === 'string' ? { text: l } : l;
        return h('div', { key: i, className: cx('hz-term-line', o.kind && 'hz-term-' + o.kind) }, o.kind === 'cmd' ? h('span', { className: 'hz-term-prompt' }, (p.prompt || '$') + ' ') : null, o.text);
      }), p.cursor !== false ? h('span', { className: 'hz-term-cursor' }) : null));
  }

  function NavRail(p) {
    return h('nav', { className: 'hz-nav', 'aria-label': 'Hauptnavigation' },
      h('div', { className: 'hz-nav-brand' }, h('span', { className: 'hz-mark', 'aria-hidden': true }, h('span')), h('span', null, p.title || 'homelab')),
      h('ul', null, (p.items || []).map(function (it, i) {
        return h('li', { key: it.id }, h('a', { href: it.href || '#', className: cx('hz-nav-item', it.id === p.active && 'hz-nav-active'), 'aria-current': it.id === p.active ? 'page' : undefined },
          h('span', { className: 'hz-nav-key' }, it.key || String(i + 1)), h('span', null, it.label), it.count ? h('span', { className: 'hz-nav-count' }, it.count) : null));
      })));
  }

  function ServerSwitch(p) {
    return h('div', { className: 'hz-servers', role: 'tablist', 'aria-label': 'Server' }, (p.servers || []).map(function (s) {
      var on = s.id === p.active;
      return h('button', { key: s.id, type: 'button', role: 'tab', 'aria-selected': on, className: cx('hz-server', on && 'hz-server-on'), onClick: function () { p.onChange && p.onChange(s.id); } },
        s.id === 'all' ? null : h(StatusDot, { status: s.status || 'ok', hideLabel: true }), h('span', null, s.name));
    }));
  }

  window.HZ = Object.assign(window.HZ || {}, { Icon: Icon, Button: Button, StatusDot: StatusDot, Badge: Badge, Tile: Tile, Metric: Metric, UsageBar: UsageBar, BlockBar: BlockBar, Sparkline: Sparkline, ServerList: ServerList, ServiceRow: ServiceRow, WebCheckRow: WebCheckRow, RepoRow: RepoRow, CommitRow: CommitRow, GameServer: GameServer, GameTemplates: GameTemplates, ShareLink: ShareLink, Toggle: Toggle, Alert: Alert, Terminal: Terminal, NavRail: NavRail, ServerSwitch: ServerSwitch });
})();
