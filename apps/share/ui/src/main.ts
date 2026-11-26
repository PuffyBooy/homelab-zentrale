import { download, request, type Credentials, type RequestSpec, type Result } from './api.js';
import { alertBox, append, button, field, h, icon, statusDot, tile } from './dom.js';
import {
  ACTION_TEXT,
  commandError,
  controlsFor,
  downloadErrorLine,
  downloadName,
  errorLine,
  expiresText,
  formatWhen,
  isConsoleResponse,
  isFinal,
  isOutputResponse,
  isShareStatus,
  isSleeping,
  mergeLines,
  messageFor,
  pinText,
  playerError,
  progressText,
  REQUEST_STATE_TEXT,
  screenFor,
  statusLine,
  tokenFromPath,
  type ConsoleLine,
  type Controls,
  type Failure,
  type PowerAction,
  type Screen,
  type ShareStatus,
} from './logic.js';

/**
 * Share page for friends (SPEC 6.4): one game server, only the buttons the link allows.
 * Served at /s/<token> by the core (tailnet) and by apps/share (public gateway).
 * No navigation, no links, no external requests, no inline scripts.
 */

// The share API allows 10 requests/min for status and actions together (gateway rate limit).
const STATUS_EVERY_MS = 15_000;
const CONSOLE_EVERY_MS = 3_000;

// ---- theme: dark by default, light when the device asks for it ------------------------

const LIGHT = window.matchMedia('(prefers-color-scheme: light)');
const applyTheme = (): void => {
  document.documentElement.dataset.theme = LIGHT.matches ? 'light' : 'dark';
};
applyTheme();
LIGHT.addEventListener('change', applyTheme);

// ---- state -----------------------------------------------------------------------------

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const app: HTMLElement = root;
const live = h('div', { class: 'hz-sr', 'aria-live': 'polite' });

const token = tokenFromPath(window.location.pathname);
const cred: Credentials = { token: token ?? '', pin: null };

let screen: Screen = { kind: 'loading' };
let gen = 0;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let consoleTimer: ReturnType<typeof setTimeout> | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let view: ReadyView | null = null;

function say(text: string): void {
  live.textContent = '';
  // A fresh text node, so screen readers announce repeated messages too.
  window.setTimeout(() => (live.textContent = text), 30);
}

function clearTimers(): void {
  for (const t of [statusTimer, consoleTimer, lockTimer]) if (t) clearTimeout(t);
  statusTimer = consoleTimer = lockTimer = null;
}

function call<T>(spec: RequestSpec<T>): Promise<Result<T>> {
  return request(cred, spec);
}

// ---- screens ---------------------------------------------------------------------------

function show(next: Screen): void {
  const prev = screen.kind;
  screen = next;
  if (next.kind === 'ready') {
    if (!view) {
      view = new ReadyView(next.status);
      // First load: no focus move; after a PIN or an error screen, the heading is read out.
      mount(view.root, prev !== 'ready' && prev !== 'loading');
    } else {
      view.update(next.status);
    }
    return;
  }
  view = null;
  clearTimers();
  gen++;
  if (next.kind === 'loading') mount(loadingScreen(), false);
  else if (next.kind === 'pin') mount(pinScreen(next), true);
  else mount(messageScreen(next), true);
  if (next.kind === 'locked') {
    const wait = Math.max(1000, next.until.getTime() - Date.now());
    lockTimer = setTimeout(() => {
      cred.pin = null;
      void loadStatus();
    }, wait);
  }
}

/** Replaces the page; moves focus to the new heading so it is read out. */
function mount(el: HTMLElement, focus: boolean): void {
  app.replaceChildren(el, live);
  if (focus) el.querySelector<HTMLElement>('[data-focus]')?.focus({ preventScroll: true });
}

function heading(text: string): HTMLHeadingElement {
  return h('h1', { class: 'display sh-title', tabindex: '-1', 'data-focus': true }, text);
}

function loadingScreen(): HTMLElement {
  return h('main', { class: 'sh-page sh-narrow' }, h('p', { class: 'sh-sub' }, 'Lade …'));
}

function messageScreen(s: Screen): HTMLElement {
  const m = messageFor(s) ?? {
    tone: 'crit' as const,
    title: 'Link ungültig.',
    text: 'Prüf, ob der Link vollständig kopiert ist.',
  };
  document.title = `${m.title} · Benutzerlink`;
  return h(
    'main',
    { class: 'sh-page sh-narrow' },
    heading(m.title),
    alertBox(m.tone, m.title, m.text),
  );
}

function pinScreen(s: Extract<Screen, { kind: 'pin' }>): HTMLElement {
  document.title = 'PIN eingeben · Benutzerlink';
  const pin = field(
    'PIN',
    {
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: 4,
      required: true,
      'data-focus': true,
    },
    'Die 4 Ziffern hast du zusammen mit dem Link bekommen.',
  );
  pin.setError(pinText(s));
  const submit = button({ label: 'Öffnen', variant: 'primary', type: 'submit', icon: 'lock' });
  const form = h(
    'form',
    { class: 'hz-form', novalidate: true },
    pin.root,
    h('div', { class: 'hz-form-actions' }, submit),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = pin.input.value.trim();
    if (!/^\d{4}$/.test(v)) {
      pin.setError('Genau 4 Ziffern.');
      pin.input.focus();
      return;
    }
    cred.pin = v;
    submit.disabled = true;
    void loadStatus();
  });
  return h(
    'main',
    { class: 'sh-page sh-narrow' },
    h('h1', { class: 'display sh-title' }, 'PIN eingeben'),
    tile({
      title: 'Benutzerlink mit PIN',
      icon: 'lock',
      body: [h('p', { class: 'sh-text' }, 'Dieser Link ist mit einer PIN geschützt.'), form],
    }),
  );
}

// ---- the game page -----------------------------------------------------------------------

class ReadyView {
  readonly root: HTMLElement;
  private status: ShareStatus;
  private controls: Controls;
  private pending: PowerAction | null = null;
  private readonly title = heading('');
  private readonly sub = h('p', { class: 'sh-sub' });
  private readonly gameTile = h('section', { class: 'hz-tile hz-game' });
  private readonly errorSlot = h('div', { class: 'sh-slot' });
  private readonly foot = h('p', { class: 'sh-foot' });
  readonly consolePart: ConsolePart | null;
  private readonly whitelistPart: HTMLElement | null;
  private readonly requestPart: RequestPart | null;
  private readonly worldPart: HTMLElement | null;

  constructor(s: ShareStatus) {
    this.status = s;
    this.controls = controlsFor(s);
    this.consolePart = this.controls.console ? new ConsolePart(this.controls.command) : null;
    this.whitelistPart = this.controls.whitelist ? whitelistTile() : null;
    this.requestPart = this.controls.whitelistRequest
      ? new RequestPart((next) => this.update(next))
      : null;
    this.worldPart = this.controls.worldDownload ? worldTile(() => this.status.game.name) : null;
    this.root = h(
      'main',
      { class: 'sh-page' },
      h('header', { class: 'sh-head' }, this.title, this.sub),
      this.gameTile,
      this.errorSlot,
      this.consolePart?.root,
      this.whitelistPart,
      this.requestPart?.root,
      this.worldPart,
      this.foot,
    );
    this.render();
    if (this.consolePart) scheduleConsole(0);
  }

  /** An action is running: the status poll waits (shared rate limit). */
  get busy(): boolean {
    return this.pending !== null;
  }

  update(s: ShareStatus): void {
    this.status = s;
    this.controls = controlsFor(s);
    this.render();
  }

  setError(text: string | null): void {
    this.errorSlot.replaceChildren(...(text ? [alertBox('crit', text)] : []));
  }

  private render(): void {
    const { game, person, expiresAt } = this.status;
    document.title = `${game.name} · Benutzerlink`;
    this.title.textContent = game.name;
    this.sub.textContent = statusLine(game);
    this.foot.textContent = `Benutzerlink für ${person} · ${expiresText(expiresAt)}`;
    this.requestPart?.render(this.status.whitelistRequests);
    this.renderGame();
  }

  /** Same markup as the GameServer tile, without host, RAM and TPS (internal). */
  private renderGame(): void {
    const g = this.status.game;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusKey = focused && this.gameTile.contains(focused) ? focused.dataset.key : undefined;

    const addr = g.address
      ? addressButton(g.address)
      : h('div', { class: 'sh-text' }, 'Keine Adresse hinterlegt.');
    const pl = g.players;
    const players = h(
      'div',
      { class: 'hz-game-players' },
      h('span', { class: 'hz-num' }, pl ? String(pl.online) : '0'),
      h('span', { class: 'hz-unit' }, `/${pl ? pl.max : 0}`),
      h('div', { class: 'hz-label' }, 'Spieler'),
    );
    const online =
      pl && pl.names.length
        ? h(
            'div',
            { class: 'hz-game-online', 'aria-label': 'Spieler online' },
            ...pl.names.map((n) => h('span', {}, n)),
          )
        : null;

    const actions = this.actions();
    this.gameTile.className =
      g.status === 'crit' ? 'hz-tile hz-game hz-tile-crit' : 'hz-tile hz-game';
    this.gameTile.replaceChildren(
      h(
        'header',
        { class: 'hz-tile-head' },
        h('div', { class: 'hz-tile-title' }, icon('gamepad', 12), h('span', {}, g.name)),
        isSleeping(g)
          ? statusDot(g.status, 'Schläft – Starten weckt den Server', 'Schläft')
          : statusDot(g.status, g.statusText),
      ),
      h(
        'div',
        { class: 'hz-game-body' },
        h(
          'div',
          { class: 'hz-game-top' },
          h(
            'div',
            {},
            h('div', { class: 'hz-label' }, g.game + (g.version ? ` · ${g.version}` : '')),
            addr,
          ),
          players,
        ),
        online,
      ),
      ...(actions ? [actions] : []),
    );
    if (focusKey) this.gameTile.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }

  private actions(): HTMLElement | null {
    const c = this.controls;
    const off = c.disabled || this.pending !== null;
    const list: HTMLButtonElement[] = [];
    if (c.power === 'start') {
      list.push(
        button({
          label: 'Starten',
          variant: 'primary',
          size: 'sm',
          icon: 'play',
          disabled: off,
          onClick: () => void this.act('start'),
          attrs: { 'data-key': 'power' },
        }),
      );
    } else if (c.power === 'stop') {
      list.push(
        button({
          label: 'Stoppen',
          size: 'sm',
          icon: 'stop',
          disabled: off,
          onClick: () => void this.act('stop'),
          attrs: { 'data-key': 'power' },
        }),
      );
    }
    if (c.restart) {
      list.push(
        button({
          label: 'Neu starten',
          size: 'sm',
          icon: 'refresh',
          disabled: off || this.status.game.status === 'off',
          onClick: () => void this.act('restart'),
          attrs: { 'data-key': 'restart' },
        }),
      );
    }
    if (!list.length) return null;
    const busy = this.pending
      ? h('span', { class: 'sh-busy' }, `${ACTION_TEXT[this.pending].verb} …`)
      : null;
    return h('footer', { class: 'hz-game-actions' }, ...list, busy);
  }

  private async act(a: PowerAction): Promise<void> {
    if (this.pending) return;
    this.pending = a;
    this.setError(null);
    this.renderGame();
    const myGen = gen;
    const r = await call({
      method: 'POST',
      path: '/s/api/action',
      body: { action: a },
      guard: isShareStatus,
    });
    if (myGen !== gen || view !== this) return;
    this.pending = null;
    if (r.ok) {
      this.update(r.data);
      say(`${r.data.game.name} ${ACTION_TEXT[a].done}.`);
    } else {
      this.renderGame();
      fail(r.failure);
    }
  }
}

function addressButton(address: string): HTMLButtonElement {
  const b = h(
    'button',
    { type: 'button', class: 'hz-addr', title: 'Adresse kopieren', 'data-key': 'addr' },
    h('span', {}, address),
    icon('copy', 12),
  );
  b.addEventListener('click', () => {
    void copy(address).then((ok) =>
      say(
        ok ? `Adresse ${address} kopiert.` : 'Kopieren ging nicht. Adresse markieren und kopieren.',
      ),
    );
  });
  return b;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- console -----------------------------------------------------------------------------

class ConsolePart {
  readonly root: HTMLElement;
  private readonly body = h('pre', {
    class: 'hz-term-body sh-term-body',
    tabindex: '0',
    'aria-label': 'Konsole',
    'aria-live': 'off',
  });
  private lines: ConsoleLine[] = [];
  lastId: string | undefined;

  constructor(canWrite: boolean) {
    const term = h(
      'div',
      // The terminal is always dark; its own subtree keeps status colours readable.
      { class: 'hz-term', 'data-theme': 'dark' },
      h(
        'div',
        { class: 'hz-term-head' },
        h('span', {}, 'konsole'),
        h('span', { class: 'hz-term-host' }, canWrite ? 'lesen und schreiben' : 'nur lesen'),
      ),
      this.body,
    );
    this.body.append(h('div', { class: 'hz-term-line hz-term-dim' }, 'Warte auf Ausgabe …'));
    this.root = tile({
      title: 'Konsole',
      icon: 'terminal',
      body: [term, canWrite ? commandForm(() => scheduleConsole(0)) : null],
    });
  }

  add(incoming: readonly ConsoleLine[]): void {
    if (!incoming.length) return;
    const before = this.lines.length;
    this.lines = mergeLines(this.lines, incoming);
    this.lastId = this.lines[this.lines.length - 1]?.id ?? this.lastId;
    if (this.lines.length === before && before > 0) return;
    const nearBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    this.body.replaceChildren(
      ...this.lines.map((l) =>
        h(
          'div',
          { class: l.kind === 'err' ? 'hz-term-line hz-term-err' : 'hz-term-line' },
          l.kind === 'cmd' ? h('span', { class: 'hz-term-prompt' }, '> ') : null,
          l.text,
        ),
      ),
    );
    if (nearBottom || before === 0) this.body.scrollTop = this.body.scrollHeight;
  }
}

function commandForm(onSent: () => void): HTMLElement {
  const input = h('input', {
    class: 'hz-input hz-input-mono',
    'aria-label': 'Befehl',
    placeholder: 'z. B. list',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    maxlength: 200,
  });
  const send = button({ label: 'Senden', type: 'submit', icon: 'terminal' });
  const out = h('div', { class: 'hz-field-hint sh-output', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'sh-console-form', novalidate: true },
    h(
      'div',
      { class: 'sh-console-line' },
      h('span', { class: 'sh-console-prompt', 'aria-hidden': 'true' }, '>'),
      input,
      send,
    ),
    out,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = commandError(input.value);
    if (err) {
      out.textContent = err;
      input.focus();
      return;
    }
    send.disabled = true;
    const myGen = gen;
    void call({
      method: 'POST',
      path: '/s/api/console',
      body: { command: input.value.trim() },
      guard: isOutputResponse,
    }).then((r) => {
      if (myGen !== gen) return;
      send.disabled = false;
      if (r.ok) {
        input.value = '';
        out.textContent = r.data.output ? `Antwort: ${r.data.output}` : 'Gesendet.';
        onSent();
      } else if (!fail(r.failure)) {
        out.textContent = errorLine(r.failure);
      }
      input.focus();
    });
  });
  return form;
}

function scheduleConsole(ms: number): void {
  if (consoleTimer) clearTimeout(consoleTimer);
  consoleTimer = setTimeout(() => void loadConsole(), ms);
}

async function loadConsole(): Promise<void> {
  const part = view?.consolePart ?? null;
  if (!part) return;
  const myGen = gen;
  const q = part.lastId ? `?after=${encodeURIComponent(part.lastId)}` : '';
  const r = await call({ path: `/s/api/console${q}`, guard: isConsoleResponse });
  if (myGen !== gen || !view) return;
  if (r.ok) part.add(r.data.lines);
  else if (r.failure.error === 'forbidden') return;
  else if (fail(r.failure)) return;
  scheduleConsole(CONSOLE_EVERY_MS);
}

// ---- whitelist ---------------------------------------------------------------------------

function whitelistTile(): HTMLElement {
  const player = field(
    'Spielername',
    {
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      maxlength: 16,
      placeholder: 'Steve',
    },
    'Genau so, wie er im Spiel heißt.',
  );
  const add = button({ label: 'Hinzufügen', type: 'submit', icon: 'plus' });
  const remove = button({ label: 'Entfernen', variant: 'ghost' });
  const out = h('div', { class: 'sh-slot', 'aria-live': 'polite' });
  const run = (op: 'add' | 'remove'): void => {
    const name = player.input.value.trim();
    const err = playerError(name);
    player.setError(err);
    if (err) {
      player.input.focus();
      return;
    }
    add.disabled = remove.disabled = true;
    const myGen = gen;
    void call({
      method: 'POST',
      path: '/s/api/whitelist',
      body: { op, player: name },
      guard: isOutputResponse,
    }).then((r) => {
      if (myGen !== gen) return;
      add.disabled = remove.disabled = false;
      if (r.ok) {
        out.replaceChildren(
          alertBox(
            'ok',
            op === 'add'
              ? `${name} steht auf der Whitelist.`
              : `${name} ist von der Whitelist entfernt.`,
            r.data.output || undefined,
          ),
        );
        player.input.value = '';
      } else if (!fail(r.failure)) {
        out.replaceChildren(alertBox('crit', errorLine(r.failure)));
      }
    });
  };
  const form = h(
    'form',
    { class: 'hz-form', novalidate: true },
    player.root,
    h('div', { class: 'hz-form-actions' }, remove, add),
    out,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run('add');
  });
  remove.addEventListener('click', () => run('remove'));
  return tile({ title: 'Whitelist', icon: 'users', body: [form] });
}

// ---- M12: whitelist request -----------------------------------------------------------

class RequestPart {
  readonly root: HTMLElement;
  private readonly list = h('div', { class: 'sh-requests' });

  constructor(onStatus: (s: ShareStatus) => void) {
    const player = field(
      'Spielername',
      {
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        maxlength: 16,
        placeholder: 'Steve',
      },
      'Genau so, wie er im Spiel heißt. Der Admin bestätigt die Anfrage.',
    );
    const send = button({ label: 'Anfrage senden', type: 'submit', icon: 'plus' });
    const out = h('div', { class: 'sh-slot', 'aria-live': 'polite' });
    const form = h(
      'form',
      { class: 'hz-form', novalidate: true },
      player.root,
      h('div', { class: 'hz-form-actions' }, send),
      out,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = player.input.value.trim();
      const err = playerError(name);
      player.setError(err);
      if (err) {
        player.input.focus();
        return;
      }
      send.disabled = true;
      const myGen = gen;
      void call({
        method: 'POST',
        path: '/s/api/whitelist-request',
        body: { player: name },
        guard: isShareStatus,
      }).then((r) => {
        if (myGen !== gen) return;
        send.disabled = false;
        if (r.ok) {
          player.input.value = '';
          out.replaceChildren(
            alertBox('ok', `Anfrage für ${name} gesendet.`, 'Der Admin bekommt eine Meldung.'),
          );
          onStatus(r.data);
        } else if (r.failure.error === 'busy') {
          out.replaceChildren(alertBox('warn', `Für ${name} gibt es schon eine Anfrage.`));
        } else if (!fail(r.failure)) {
          out.replaceChildren(alertBox('crit', errorLine(r.failure)));
        }
      });
    });
    this.root = tile({
      title: 'Auf die Whitelist',
      icon: 'users',
      body: [form, this.list],
    });
  }

  render(requests: ShareStatus['whitelistRequests']): void {
    if (!requests.length) {
      this.list.replaceChildren();
      return;
    }
    this.list.replaceChildren(
      h('div', { class: 'hz-label' }, 'Deine Anfragen'),
      ...requests.map((r) => {
        const st = REQUEST_STATE_TEXT[r.state];
        return h(
          'div',
          { class: 'hz-row' },
          statusDot(st.status, st.text, st.text),
          h(
            'div',
            { class: 'hz-row-main' },
            h('span', { class: 'hz-row-name' }, r.player),
            h('span', { class: 'hz-row-sub' }, formatWhen(new Date(r.createdAt))),
          ),
        );
      }),
    );
  }
}

// ---- M12: world download ------------------------------------------------------------------

function worldTile(gameName: () => string): HTMLElement {
  const get = button({ label: 'Welt herunterladen', icon: 'cloud' });
  const out = h('div', { class: 'sh-slot', 'aria-live': 'polite' });
  const progress = h('p', { class: 'sh-text', hidden: true });
  get.addEventListener('click', () => {
    get.disabled = true;
    out.replaceChildren();
    progress.hidden = false;
    progress.textContent = 'Server packt die Welt …';
    const myGen = gen;
    let last = 0;
    void download(cred, '/s/api/world', (loaded, total) => {
      // Update the line at most every 256 KB, not on every chunk.
      if (loaded - last < 256 * 1024 && loaded !== total) return;
      last = loaded;
      progress.textContent = `Lädt … ${progressText(loaded, total)}`;
    }).then((r) => {
      if (myGen !== gen) return;
      get.disabled = false;
      progress.hidden = true;
      if (r.ok) {
        const name = downloadName(r.data.disposition, gameName());
        saveBlob(r.data.blob, name);
        out.replaceChildren(
          alertBox(
            'ok',
            `${name} gespeichert.`,
            `${progressText(r.data.blob.size, null)}. Nächster Download in 1 Stunde.`,
          ),
        );
        say(`${name} gespeichert.`);
      } else if (!fail(r.failure)) {
        out.replaceChildren(alertBox('crit', downloadErrorLine(r.failure)));
      }
    });
  });
  return tile({
    title: 'Welt',
    icon: 'cloud',
    body: [
      h(
        'p',
        { class: 'sh-text' },
        'Die Welt als tar.zst. Höchstens 1× pro Stunde, kann mehrere GB groß sein. Die Seite lädt sie zuerst ganz, dann speichert der Browser die Datei.',
      ),
      h('div', { class: 'hz-form-actions' }, get),
      progress,
      out,
    ],
  });
}

/** Saves a Blob as a file through a temporary object URL (no token in any URL). */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- polling -----------------------------------------------------------------------------

/**
 * Handles a failed request. Returns true when it replaced the page (revoked, expired,
 * PIN, locked …); otherwise the ready page shows the line and keeps polling.
 */
function fail(f: Failure): boolean {
  const next = screenFor(f);
  if (next) {
    if (next.kind === 'pin' && !next.wrong && cred.pin) {
      // The PIN we had is no longer accepted (e.g. link changed): ask again.
      cred.pin = null;
    }
    show(next);
    return true;
  }
  if (view) view.setError(errorLine(f));
  else mount(messageScreen({ kind: 'invalid' }), true);
  return false;
}

async function loadStatus(): Promise<void> {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  if (view?.busy) {
    statusTimer = setTimeout(() => void loadStatus(), STATUS_EVERY_MS);
    return;
  }
  const myGen = gen;
  const r = await call({ path: '/s/api/status', guard: isShareStatus });
  if (myGen !== gen) return;
  if (r.ok) {
    view?.setError(null);
    show({ kind: 'ready', status: r.data });
  } else {
    if (r.failure.error === 'pin_wrong' || r.failure.error === 'locked') cred.pin = null;
    if (!view && !screenFor(r.failure)) {
      // Nothing to show yet: say what is wrong and try again.
      mount(
        h(
          'main',
          { class: 'sh-page sh-narrow' },
          heading('Benutzerlink'),
          alertBox('warn', errorLine(r.failure)),
        ),
        false,
      );
    } else if (fail(r.failure)) {
      return;
    }
  }
  if (!isFinal(screen) && screen.kind !== 'pin' && screen.kind !== 'locked') {
    statusTimer = setTimeout(() => void loadStatus(), STATUS_EVERY_MS);
  }
}

// ---- start -------------------------------------------------------------------------------

append(app, [live]);
if (!token) {
  show({ kind: 'invalid' });
} else {
  show({ kind: 'loading' });
  void loadStatus();
}
