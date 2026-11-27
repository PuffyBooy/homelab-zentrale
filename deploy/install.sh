#!/usr/bin/env bash
# Guided installer for the Homelab-Zentrale (core + web) on a fresh server.
#
#   sudo ./deploy/install.sh                 install or reconfigure (wizard)
#   sudo ./deploy/install.sh update          pull (or rebuild) the image, restart, health check
#   sudo ./deploy/install.sh status          container, health, tailscale serve
#   sudo ./deploy/install.sh uninstall       stop and remove; data and key stay
#   sudo ./deploy/install.sh uninstall --purge   also delete the database and the key
#
#   sudo ./deploy/install.sh share           share gateway on a public server (optional)
#   sudo ./deploy/install.sh share update | share status | share uninstall
#
# Options:
#   -y, --yes              no questions, take the defaults (and install missing Docker/Tailscale)
#   --build-local          build the image from this checkout instead of pulling it from GHCR
#   --image <ref>          fixed image, e.g. ghcr.io/puffybooy/homelab-core:sha-<short>
#   --modules <list>       github=0|1,homeassistant=0|1,games=0|1,storage=0|1 (only before the first login)
#   --timezone <zone>      IANA zone, default: the server's zone or Europe/Vienna
#   --base-url <url>       https://<name>.ts.net (default: read from `tailscale status`)
#   --no-serve             do not set up `tailscale serve`
#   --purge                with uninstall: delete data volume and key as well
#   --domain <name>        with share: public DDNS name for Caddy (e.g. spiel.example.duckdns.org)
#   --core-url <url>       with share: https://<core>.ts.net
#   --token-stdin          with share: read the gateway token from stdin
#   --allow-no-nnp         start without no-new-privileges where the host refuses it
#                          (docker snap, LXC); asked interactively, never assumed by --yes
#
# Secrets: the gateway token is never accepted as an argument (shell history, `ps`):
# use HZ_SHARE_GATEWAY_TOKEN, --token-stdin or the hidden prompt. A Tailscale auth key
# can come from HZ_TS_AUTHKEY; it is passed to tailscale as a 0600 file, never as an argument.
#
# The core is never public: it listens on 127.0.0.1:8080 and is shared in the tailnet
# with `tailscale serve` only. This script never enables `tailscale funnel` and turns
# it off if it finds it on port 443 (docs/NETWORK.md).
set -euo pipefail

# Never trace this script: it handles secrets.
case $- in *x*)
  set +x
  echo "Hinweis: xtrace (bash -x) ist abgeschaltet, damit keine Secrets im Log landen." >&2
  ;;
esac
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF_DIR=/etc/homelab-zentrale
SHARE_DIR=/etc/homelab-share
CADDY_FILE=/etc/caddy/Caddyfile
# Paths are overridable in test mode only (test/install.security.test.ts), so a stray
# variable can never point --purge at another directory.
if [[ "${HZ_INSTALL_ALLOW_NONROOT:-0}" == 1 ]]; then
  CONF_DIR="${HZ_CONF_DIR:-$CONF_DIR}"
  SHARE_DIR="${HZ_SHARE_CONF_DIR:-$SHARE_DIR}"
  CADDY_FILE="${HZ_CADDY_FILE:-$CADDY_FILE}"
fi
HEALTH_TIMEOUT="${HZ_HEALTH_TIMEOUT:-90}"

CORE_ENV="$CONF_DIR/core.env"
CORE_COMPOSE="$CONF_DIR/docker-compose.yml"
CORE_URL_LOCAL="http://127.0.0.1:8080"
DEFAULT_IMAGE=ghcr.io/puffybooy/homelab-core:latest
LOCAL_IMAGE=homelab-zentrale/core:local
SHARE_DEFAULT_IMAGE=ghcr.io/puffybooy/homelab-share:latest
SHARE_LOCAL_IMAGE=homelab-zentrale/share:local
VOLUME=homelab-zentrale_hz-data

# --- output -------------------------------------------------------------------
if [[ -t 1 ]]; then
  B=$'\e[1m' YEL=$'\e[33m' RED=$'\e[31m' GRN=$'\e[32m' R=$'\e[0m'
else
  B="" YEL="" RED="" GRN="" R=""
fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$R"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %sOK%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '    %sWARN%s %s\n' "$YEL" "$R" "$*" >&2; }
die() {
  printf '%sFehler:%s %s\n' "$RED" "$R" "$*" >&2
  exit 1
}

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- arguments ----------------------------------------------------------------
target=core
mode=install
yes=0
build_local=0
if [[ "${HZ_BUILD_LOCAL:-0}" == 1 ]]; then build_local=1; fi
image=""
modules_arg=""
timezone_arg=""
base_url_arg=""
serve=1
purge=0
domain=""
core_url_arg=""
token_stdin=0
allow_no_nnp=0

need_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 braucht einen Wert"; }

positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y | --yes) yes=1; shift ;;
    --build-local) build_local=1; shift ;;
    --image) need_value "$@"; image="$2"; shift 2 ;;
    --modules) need_value "$@"; modules_arg="$2"; shift 2 ;;
    --timezone) need_value "$@"; timezone_arg="$2"; shift 2 ;;
    --base-url) need_value "$@"; base_url_arg="$2"; shift 2 ;;
    --no-serve) serve=0; shift ;;
    --purge) purge=1; shift ;;
    --domain) need_value "$@"; domain="$2"; shift 2 ;;
    --core-url) need_value "$@"; core_url_arg="$2"; shift 2 ;;
    --token-stdin) token_stdin=1; shift ;;
    --allow-no-nnp) allow_no_nnp=1; shift ;;
    --token | --token=* | --auth-key | --auth-key=* | --secret-key | --secret-key=*)
      die "Secrets nie als Argument übergeben (Shell-History, ps), siehe --help" ;;
    -h | --help) usage 0 ;;
    -*) echo "Unbekannte Option: $1" >&2; usage 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
set -- "${positional[@]+"${positional[@]}"}"
if [[ "${1:-}" == share ]]; then
  target=share
  shift
fi
if [[ $# -gt 0 ]]; then
  case "$1" in
    install | update | status | uninstall) mode="$1"; shift ;;
    *) echo "Unbekannter Modus: $1" >&2; usage 2 ;;
  esac
fi
[[ $# -eq 0 ]] || { echo "Zu viele Argumente: $*" >&2; usage 2; }

if [[ $EUID -ne 0 && "${HZ_INSTALL_ALLOW_NONROOT:-0}" != 1 ]]; then
  die "bitte als root ausführen (sudo $0 ${mode})"
fi

interactive=0
if [[ $yes -eq 0 && -t 0 ]]; then interactive=1; fi

# --- validation ---------------------------------------------------------------
image_re='^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$'
tz_re='^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'
ts_host_re='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$'
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
gateway_token_re='^[A-Za-z0-9_-]{43}$'

valid_ts_url() {
  [[ "$1" =~ ^https://([^/]+)/?$ ]] && [[ "${BASH_REMATCH[1]}" =~ $ts_host_re ]]
}

valid_modules() {
  local part
  local -a parts
  [[ -n "$1" ]] || return 1
  IFS=',' read -r -a parts <<<"$1"
  for part in "${parts[@]}"; do
    [[ "$part" =~ ^(github|homeassistant|games|storage)=[01]$ ]] || return 1
  done
}

if [[ -n "$image" ]]; then
  [[ "$image" =~ $image_re ]] || die "--image ist kein gültiger Image-Name"
  [[ $build_local -eq 0 ]] || die "--image und --build-local schließen sich aus"
fi
if [[ -n "$modules_arg" ]]; then
  valid_modules "$modules_arg" || die "--modules: z. B. github=1,homeassistant=0,games=1,storage=1"
fi
if [[ -n "$timezone_arg" ]]; then
  [[ "$timezone_arg" =~ $tz_re ]] || die "--timezone: z. B. Europe/Vienna"
fi
if [[ -n "$base_url_arg" ]]; then
  valid_ts_url "$base_url_arg" || die "--base-url muss https://<name>.ts.net sein (nie öffentlich)"
  base_url_arg="${base_url_arg%/}"
fi
if [[ -n "$core_url_arg" ]]; then
  valid_ts_url "$core_url_arg" || die "--core-url muss https://<name>.ts.net sein"
  core_url_arg="${core_url_arg%/}"
fi
if [[ -n "$domain" ]]; then
  [[ "$domain" =~ $domain_re ]] || die "--domain ist kein gültiger Name (z. B. spiel.example.duckdns.org)"
  [[ ! "$domain" =~ \.ts\.net$ ]] || die "--domain ist der öffentliche Name, nicht die ts.net-Adresse"
fi

# --- prompts ------------------------------------------------------------------
# ask <question> <default>  -> answer on stdout (default without a terminal or with --yes)
ask() {
  local answer=""
  if [[ $interactive -eq 1 ]]; then
    read -r -p "    $1 [$2]: " answer || true
  fi
  printf '%s' "${answer:-$2}"
}

# confirm <question> <default j|n>: default on Enter or with --yes; "no" without a terminal.
confirm() {
  local def="$2" hint answer
  if [[ "$def" == j ]]; then hint="J/n"; else hint="j/N"; fi
  if [[ $interactive -eq 1 ]]; then
    read -r -p "    $1 [$hint] " answer || true
  elif [[ $yes -eq 1 ]]; then
    answer=""
  else
    # No terminal and no --yes: never assume consent.
    answer=n
  fi
  answer="${answer:-$def}"
  [[ "$answer" =~ ^[jJyY] ]]
}

# --- env files ----------------------------------------------------------------
env_get() { # env_get <file> <key>
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# env_set <file> <key> <value>: atomic rewrite, mode 0600, value without newlines.
env_set() {
  local file="$1" key="$2" value="$3" tmp
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "ungültiger Wert für $key"
  tmp="$(umask 077 && mktemp "$(dirname "$file")/.env.XXXXXX")"
  if [[ -f "$file" ]]; then
    grep -v "^$key=" "$file" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$file"
}

new_secret_key() {
  local k
  if command -v openssl >/dev/null 2>&1; then
    k="$(openssl rand -base64 32)"
  else
    k="$(head -c 32 /dev/urandom | base64)"
  fi
  [[ "$k" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "konnte keinen Schlüssel erzeugen"
  printf '%s' "$k"
}

# --- system -------------------------------------------------------------------
os_id() {
  local id="" like=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck source=/dev/null
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck source=/dev/null
    like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
  fi
  case "$id" in
    ubuntu | debian | raspbian) printf '%s' "$id" ;;
    *)
      case " $like " in
        *" ubuntu "*) printf ubuntu ;;
        *" debian "*) printf debian ;;
        *) printf unknown ;;
      esac
      ;;
  esac
}

os_codename() {
  # shellcheck source=/dev/null
  (. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
}

install_docker() {
  local id codename arch
  id="$(os_id)"
  [[ "$id" != unknown ]] || die "Docker automatisch nur auf Debian/Ubuntu. Sonst: https://docs.docker.com/engine/install/"
  [[ "$id" != raspbian ]] || id=debian
  codename="$(os_codename)"
  [[ "$codename" =~ ^[a-z]+$ ]] || die "Distribution nicht erkannt (VERSION_CODENAME fehlt)"
  arch="$(dpkg --print-architecture)"
  info "Docker aus dem offiziellen Repository (download.docker.com/linux/$id, $codename, $arch)"
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$id/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$arch" "$id" "$codename" >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

install_tailscale() {
  local id codename
  id="$(os_id)"
  [[ "$id" != unknown ]] || die "Tailscale automatisch nur auf Debian/Ubuntu. Sonst: https://tailscale.com/download/linux"
  codename="$(os_codename)"
  [[ "$codename" =~ ^[a-z]+$ ]] || die "Distribution nicht erkannt (VERSION_CODENAME fehlt)"
  info "Tailscale aus dem offiziellen Repository (pkgs.tailscale.com/stable/$id/$codename)"
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  curl -fsSL "https://pkgs.tailscale.com/stable/$id/$codename.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/$id/$codename.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -q
  apt-get install -y -q tailscale
  systemctl enable --now tailscaled
}

need_docker() {
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker ist nicht installiert."
    confirm "Docker jetzt installieren?" j || die "ohne Docker geht es nicht (https://docs.docker.com/engine/install/)"
    install_docker
  fi
  docker info >/dev/null 2>&1 || die "der Docker-Dienst läuft nicht (systemctl start docker)"
  check_docker_snap
  if ! docker compose version >/dev/null 2>&1; then
    warn "Docker Compose v2 fehlt."
    if [[ "$(os_id)" != unknown ]] && confirm "Paket docker-compose-plugin installieren?" j; then
      apt-get install -y -q docker-compose-plugin || die "docker-compose-plugin ließ sich nicht installieren"
    fi
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 fehlt (Paket docker-compose-plugin)"
  fi
  ok "$(docker --version)"
}

docker_snap_installed() { command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; }
docker_ce_installed() {
  [[ "$(dpkg-query -W -f='${Status}' docker-ce 2>/dev/null || true)" == "install ok installed" ]]
}

# The docker snap (offered by the Ubuntu server installer) runs dockerd under AppArmor
# confinement; then no container starts with no-new-privileges (see check_hardening).
# Removing it deletes everything stored in the snap, so it is never the default.
check_docker_snap() {
  docker_snap_installed || return 0
  warn "Docker ist als Snap installiert. Damit starten gehärtete Container (no-new-privileges) nicht."
  if docker_ce_installed; then
    info "docker-ce (download.docker.com) ist zusätzlich installiert. Empfohlen: nur docker-ce behalten."
  else
    info "Empfohlen: Snap entfernen und Docker aus download.docker.com installieren."
  fi
  info "Achtung: Entfernen löscht Container, Images und Volumes, die im Snap-Docker liegen."
  if ! confirm "Docker-Snap jetzt entfernen (snap remove --purge docker)?" n; then
    info "Snap bleibt. Von Hand: sudo snap remove --purge docker && sudo systemctl restart docker.socket docker"
    # The snap's own CLI is confined too and may not read /etc/homelab-zentrale.
    case "$(command -v docker)" in
      /snap/*) die "der docker-Befehl ist der Snap ($(command -v docker)); damit geht es nicht. Snap entfernen (siehe oben) oder docker-ce installieren" ;;
    esac
    return 0
  fi
  snap remove --purge docker || die "snap remove --purge docker ist fehlgeschlagen"
  hash -r
  if docker_ce_installed; then
    systemctl restart docker.socket docker.service || die "docker-ce ließ sich nicht starten (systemctl status docker)"
  else
    install_docker
  fi
  docker info >/dev/null 2>&1 || die "der Docker-Dienst läuft nicht (systemctl start docker)"
  ok "Docker-Snap entfernt, docker-ce läuft"
}

# tailscale status --json | <field of Self>
ts_self_dns() {
  local json name=""
  json="$(tailscale status --json 2>/dev/null)" || return 0
  if command -v jq >/dev/null 2>&1; then
    name="$(jq -r '.Self.DNSName // empty' <<<"$json")"
  elif command -v python3 >/dev/null 2>&1; then
    name="$(python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("DNSName",""))' <<<"$json")"
  else
    # "Self" comes before "Peer" in the output, so the first DNSName is our own.
    name="$(sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' <<<"$json" | head -n 1)"
  fi
  name="${name%.}"
  printf '%s' "${name,,}"
}

ts_running() {
  local json
  json="$(tailscale status --json 2>/dev/null)" || return 1
  grep -q '"BackendState": *"Running"' <<<"$json"
}

tailscale_up() {
  local keyfile
  if [[ -n "${HZ_TS_AUTHKEY:-}" ]]; then
    keyfile="$(umask 077 && mktemp)"
    trap 'rm -f -- "$keyfile"' EXIT
    printf '%s' "$HZ_TS_AUTHKEY" >"$keyfile"
    unset HZ_TS_AUTHKEY
    tailscale up --auth-key="file:$keyfile" || { rm -f "$keyfile"; die "tailscale up ist fehlgeschlagen"; }
    rm -f "$keyfile"
  else
    [[ $interactive -eq 1 ]] || die "Tailscale ist nicht angemeldet: zuerst 'sudo tailscale up' (oder HZ_TS_AUTHKEY setzen)"
    info "Gleich erscheint ein Link. Im Browser öffnen und diesen Server ins Tailnet aufnehmen."
    tailscale up || die "tailscale up ist fehlgeschlagen"
  fi
}

need_tailscale() {
  step "Tailscale"
  if ! command -v tailscale >/dev/null 2>&1; then
    warn "Tailscale ist nicht installiert. Ohne Tailscale ist die Zentrale nicht erreichbar (sie ist nie öffentlich)."
    confirm "Tailscale jetzt installieren?" j || die "ohne Tailscale geht es nicht (https://tailscale.com/download/linux)"
    install_tailscale
  fi
  if ! ts_running; then
    warn "Tailscale ist nicht angemeldet."
    tailscale_up
    ts_running || die "Tailscale läuft nicht (tailscale status)"
  fi
  ok "Tailscale läuft als $(ts_self_dns)"
}

# Turns funnel off on 443 if it is on: the core must never be public.
no_funnel() {
  local status
  status="$(tailscale serve status --json 2>/dev/null || true)"
  grep -q '"AllowFunnel"' <<<"$status" || return 0
  local port
  # "AllowFunnel": {"<host>:<port>": true, ...}: every port with funnel on is switched off.
  while IFS= read -r port; do
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || continue
    warn "tailscale funnel ist auf Port $port an. Das würde Dienste öffentlich machen, ich schalte es aus."
    tailscale funnel --https="$port" off || die "funnel ließ sich nicht ausschalten: sudo tailscale funnel --https=$port off"
  done < <(grep -oE '"[^"]+:[0-9]{1,5}": *true' <<<"$status" | sed -E 's/.*:([0-9]+)".*/\1/' | sort -u)
}

setup_serve() {
  step "Freigabe im Tailnet (tailscale serve)"
  if [[ $serve -eq 0 ]]; then
    info "übersprungen (--no-serve). Später: sudo tailscale serve --bg --https=443 $CORE_URL_LOCAL"
    return 0
  fi
  no_funnel
  if ! timeout 180 tailscale serve --bg --https=443 "$CORE_URL_LOCAL"; then
    warn "tailscale serve ist fehlgeschlagen. Meist sind HTTPS-Zertifikate im Tailnet aus:"
    warn "https://login.tailscale.com/admin/dns -> HTTPS Certificates aktivieren, dann das Skript erneut ausführen."
    return 0
  fi
  no_funnel
  ok "https://$1 -> $CORE_URL_LOCAL (nur im Tailnet)"
}

wait_health() { # wait_health <url> <seconds>
  local i body
  for ((i = 0; i < $2; i += 2)); do
    if body="$(curl -fsS --max-time 3 "$1/api/health" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

compose() { (cd "$CONF_DIR" && docker compose "$@"); }

# --- container hardening probe -----------------------------------------------
# Core and share gateway run with no-new-privileges. On some hosts Docker cannot
# start any container with it: when dockerd itself runs under an AppArmor profile
# (Docker as a snap, Ubuntu inside an LXC container, e.g. on Proxmox), the kernel
# refuses the switch to the container's profile under no_new_privs and every start
# ends in "exec /usr/local/bin/docker-entrypoint.sh: operation not permitted".
# The probe runs the image once with the same hardening as the compose file, before
# compose starts it, so such a host gets a clear diagnosis instead of a restart loop.

# probe_image <image> [extra docker run args]: the image's default entrypoint, as its user.
probe_image() {
  local img="$1"
  shift
  docker run --rm --pull never --network none --read-only --tmpfs /tmp --cap-drop ALL \
    --label hz.probe=1 "$@" "$img" node -e 'process.exit(0)'
}

# Why no-new-privileges fails here, as far as the host tells.
explain_nnp() {
  local virt="" pid label=""
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    info "Ursache: Docker ist zusätzlich als Snap installiert und läuft eingesperrt (AppArmor)."
    info "Besser: Snap entfernen und nur docker-ce nutzen:"
    info "  sudo snap remove --purge docker && sudo systemctl restart docker"
    info "Danach dieses Skript erneut starten, dann bleibt no-new-privileges an."
  fi
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    virt="$(systemd-detect-virt --container 2>/dev/null || true)"
  fi
  if [[ -n "$virt" && "$virt" != none ]]; then
    info "Ursache: dieser Server läuft selbst in einem Container ($virt, z. B. Proxmox-LXC)."
    info "Dort lässt der Kernel no-new-privileges für Docker-Container oft nicht zu."
  fi
  pid="$(pidof dockerd 2>/dev/null | awk '{print $1}' || true)"
  if [[ -n "$pid" && -r "/proc/$pid/attr/current" ]]; then
    label="$(tr -d '\0' <"/proc/$pid/attr/current" 2>/dev/null || true)"
    if [[ -n "$label" && "$label" != unconfined ]]; then
      info "dockerd läuft mit dem AppArmor-Profil: $label"
    fi
  fi
}

# check_hardening <image> <compose file> <name> [subcommand]: keep no-new-privileges
# when the host allows it; otherwise explain and (with consent) drop only that option.
check_hardening() {
  local img="$1" file="$2" name="$3" sub="${4:-}" err
  step "Härtung prüfen ($name)"
  if err="$(probe_image "$img" --security-opt no-new-privileges:true 2>&1)"; then
    ok "$name startet schreibgeschützt, ohne Capabilities und mit no-new-privileges"
    return 0
  fi
  if ! probe_image "$img" >/dev/null 2>&1; then
    printf '%s\n' "$err" | tail -n 5 >&2
    die "$name startet auf diesem Server gar nicht (Ausgabe oben). Prüfe: docker run --rm $img node -v"
  fi
  # Only the known refusal (AppArmor under no_new_privs) weakens anything.
  if ! grep -q 'operation not permitted' <<<"$err"; then
    printf '%s\n' "$err" | tail -n 5 >&2
    die "$name startet mit no-new-privileges nicht (Ausgabe oben), aus unbekanntem Grund"
  fi
  warn "$name startet hier nicht mit no-new-privileges:"
  printf '%s\n' "$err" | tail -n 2 | sed 's/^/      /' >&2
  explain_nnp
  info "Ohne no-new-privileges bleibt der Rest der Härtung: eigener Benutzer (node),"
  info "keine Capabilities, schreibgeschütztes Dateisystem, nur 127.0.0.1."
  if [[ $allow_no_nnp -ne 1 ]] && ! confirm "$name ohne no-new-privileges starten?" n; then
    die "abgebrochen. Ursache beheben (siehe oben) oder bewusst mit --allow-no-nnp starten"
  fi
  local tmp
  tmp="$(mktemp "$file.XXXXXX")"
  # Drop only that entry; drop the key too when nothing is left under it.
  awk '
    /^      - no-new-privileges:true$/ { next }
    held != "" { if ($0 !~ /^      - /) { held = ""; print; next } print held; held = "" }
    /^    security_opt:$/ { held = $0; next }
    { print }
  ' "$file" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
  if grep -q 'no-new-privileges' "$file"; then die "no-new-privileges ließ sich nicht aus $file entfernen"; fi
  warn "$name läuft ohne no-new-privileges. Nach behobener Ursache: sudo $0${sub:+ $sub} update"
}

# --- core: install ------------------------------------------------------------
write_core_compose() {
  [[ -f "$SCRIPT_DIR/docker-compose.core.yml" ]] || die "deploy/docker-compose.core.yml nicht gefunden (aus einem Checkout des Repos starten)"
  local tmp
  tmp="$(mktemp "$CONF_DIR/.compose.XXXXXX")"
  # Same file as in the repo, but with the env file of this install (core.env, required).
  sed -e 's#path: \.\./\.env#path: ./core.env#' -e 's#required: false#required: true#' \
    "$SCRIPT_DIR/docker-compose.core.yml" >"$tmp"
  grep -q 'path: ./core.env' "$tmp" || { rm -f "$tmp"; die "Compose-Datei hat ein unerwartetes Format"; }
  chmod 0644 "$tmp"
  mv -f "$tmp" "$CORE_COMPOSE"
}

resolve_image() { # sets $image; builds when local
  local saved
  saved="$(env_get "$CONF_DIR/.env" HZ_CORE_IMAGE)"
  if [[ $build_local -eq 0 && -z "$image" && "$mode" == update && "$saved" == "$LOCAL_IMAGE" ]]; then
    build_local=1
  fi
  if [[ $build_local -eq 0 && -z "$image" && "$mode" == install && $interactive -eq 1 ]]; then
    if [[ "$saved" == "$LOCAL_IMAGE" ]]; then
      confirm "Image wieder lokal aus diesem Checkout bauen (statt GHCR)?" j && build_local=1
    else
      confirm "Image lokal aus diesem Checkout bauen (statt fertig aus GHCR laden)?" n && build_local=1
    fi
  fi
  if [[ -z "$image" && $build_local -eq 0 && "$mode" == update && -n "$saved" && "$saved" =~ $image_re ]]; then
    image="$saved"
  fi
  if [[ $build_local -eq 1 ]]; then
    [[ -f "$REPO_DIR/deploy/Dockerfile.core" ]] || die "--build-local muss aus einem Checkout des Repos laufen"
    step "Image bauen (das dauert ein paar Minuten)"
    docker build -f "$REPO_DIR/deploy/Dockerfile.core" -t "$LOCAL_IMAGE" "$REPO_DIR"
    image="$LOCAL_IMAGE"
  elif [[ -z "$image" ]]; then
    image="$DEFAULT_IMAGE"
  fi
  # Interpolation variables for compose: no secrets here.
  printf '# Written by deploy/install.sh. No secrets in this file.\nHZ_CORE_IMAGE=%s\n' "$image" >"$CONF_DIR/.env"
  chmod 0644 "$CONF_DIR/.env"
}

ensure_secret_key() {
  local key repo_key
  key="$(env_get "$CORE_ENV" HZ_SECRET_KEY)"
  if [[ -n "$key" ]]; then
    ok "HZ_SECRET_KEY vorhanden (bleibt unverändert)"
    return 0
  fi
  # A manual install from the repo (.env in the checkout) keeps its key.
  repo_key="$(env_get "$REPO_DIR/.env" HZ_SECRET_KEY)"
  if [[ -n "$repo_key" && ! "$repo_key" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
    warn "HZ_SECRET_KEY in $REPO_DIR/.env hat nicht das erwartete Format (32 Byte Base64), wird nicht übernommen"
    repo_key=""
  fi
  if [[ -n "$repo_key" ]] && confirm "HZ_SECRET_KEY aus $REPO_DIR/.env übernehmen (bestehende Installation)?" j; then
    env_set "$CORE_ENV" HZ_SECRET_KEY "$repo_key"
    ok "HZ_SECRET_KEY aus der bisherigen .env übernommen"
    return 0
  fi
  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    die "Es gibt schon Daten (Volume $VOLUME), aber keinen HZ_SECRET_KEY. Mit einem neuen Schlüssel wären gespeicherte Tokens unlesbar. Alten Schlüssel als HZ_SECRET_KEY=... in $CORE_ENV eintragen (0600) und erneut starten, oder das Volume bewusst löschen: docker volume rm $VOLUME"
  fi
  key="$(new_secret_key)" || exit 1
  env_set "$CORE_ENV" HZ_SECRET_KEY "$key"
  key=""
  new_key=1
  ok "HZ_SECRET_KEY neu erzeugt (32 Byte, zufällig)"
}

detect_timezone() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then
    tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  if [[ -z "$tz" && -r /etc/timezone ]]; then tz="$(head -n 1 /etc/timezone)"; fi
  if [[ -z "$tz" || "$tz" == UTC || "$tz" == Etc/UTC || ! "$tz" =~ $tz_re ]]; then tz=Europe/Vienna; fi
  printf '%s' "$tz"
}

ask_modules() { # -> github=..,homeassistant=..,games=..
  local gh=0 ha=0 games=1 storage=1
  info "Module kannst du später jederzeit unter Einstellungen -> Module umschalten." >&2
  confirm "GitHub (Repos, CI, Deploy per Knopf, Rollback)?" n && gh=1
  confirm "Home Assistant (Wohnung, Licht, Sensoren)?" n && ha=1
  confirm "Gameserver (Vorlagen, Benutzerlinks für Freunde)?" j || games=0
  confirm "NAS und Speicher (RAID, Volumes, Festplatten, SMART)?" j || storage=0
  printf 'github=%s,homeassistant=%s,games=%s,storage=%s' "$gh" "$ha" "$games" "$storage"
}

configure_core() {
  step "Konfiguration ($CORE_ENV)"
  install -d -m 0700 "$CONF_DIR"
  if [[ -f "$CORE_ENV" ]]; then chmod 0600 "$CORE_ENV"; fi
  ensure_secret_key

  local host base tz mods
  host="$(ts_self_dns)"
  # --base-url, then the saved value, then the name from `tailscale status`.
  base="$base_url_arg"
  if [[ -z "$base" ]]; then base="$(env_get "$CORE_ENV" HZ_BASE_URL)"; fi
  if [[ -z "$base" && "$host" =~ $ts_host_re ]]; then base="https://$host"; fi
  valid_ts_url "$base" || die "keine ts.net-Adresse gefunden. MagicDNS im Tailnet einschalten oder --base-url https://<name>.ts.net angeben"
  env_set "$CORE_ENV" HZ_BASE_URL "$base"
  ok "HZ_BASE_URL=$base"

  tz="$timezone_arg"
  if [[ -z "$tz" ]]; then tz="$(env_get "$CORE_ENV" HZ_TIMEZONE)"; fi
  if [[ -z "$tz" ]]; then tz="$(ask "Zeitzone" "$(detect_timezone)")"; fi
  [[ "$tz" =~ $tz_re ]] || die "ungültige Zeitzone: z. B. Europe/Vienna"
  if [[ -d /usr/share/zoneinfo && ! -f "/usr/share/zoneinfo/$tz" ]]; then die "unbekannte Zeitzone: $tz"; fi
  env_set "$CORE_ENV" HZ_TIMEZONE "$tz"
  ok "HZ_TIMEZONE=$tz"

  mods="$modules_arg"
  if [[ -z "$mods" ]]; then mods="$(env_get "$CORE_ENV" HZ_INITIAL_MODULES)"; fi
  if [[ -z "$mods" ]]; then
    if [[ $interactive -eq 1 ]]; then
      step "Module"
      mods="$(ask_modules)"
    else
      mods="github=0,homeassistant=0,games=1,storage=1"
    fi
  fi
  valid_modules "$mods" || die "ungültige Module: $mods"
  env_set "$CORE_ENV" HZ_INITIAL_MODULES "$mods"
  ok "Module beim ersten Start: $mods"
  chmod 0600 "$CORE_ENV"
}

start_core() {
  step "Starten"
  write_core_compose
  if [[ "$image" != "$LOCAL_IMAGE" ]]; then
    info "Lade $image ..."
    compose pull core || die "docker pull ist fehlgeschlagen (Netz? Bei privaten Packages vorher docker login ghcr.io)"
  fi
  check_hardening "$image" "$CORE_COMPOSE" Core
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  compose up -d --no-build --force-recreate core
  step "Health-Check"
  if wait_health "$CORE_URL_LOCAL" "$HEALTH_TIMEOUT"; then
    ok "$CORE_URL_LOCAL/api/health antwortet"
  else
    compose logs --tail 30 core >&2 || true
    die "der Core antwortet nicht auf $CORE_URL_LOCAL/api/health (Logs oben)"
  fi
}

# The core logs a one-time setup link while no admin exists. Shown here, never stored.
show_first_login() {
  local base="$1" link=""
  link="$(compose logs --no-color --no-log-prefix --since "$started_at" core 2>/dev/null |
    sed -n 's/.*Ersteinrichtung: \([^" ]*\).*/\1/p' | tail -n 1 || true)"
  step "Erster Login"
  if [[ -n "$link" ]]; then
    info "Noch kein Admin angelegt. Öffne diesen Einmal-Link auf einem Gerät im Tailnet:"
    printf '\n      %s%s%s\n\n' "$B" "$link" "$R"
    info "1. Passwort festlegen (mind. 12 Zeichen)."
    info "2. Den QR-Code mit einer Authenticator-App scannen (TOTP) und den 6-stelligen Code eingeben."
    info "3. Wiederherstellungscodes sicher aufbewahren."
    info "Der Link gilt nur bis zum nächsten Neustart des Core. Neu anzeigen: sudo $0 status"
  else
    info "Anmelden: $base (Passwort + TOTP)."
  fi
}

remind_secret_key() {
  [[ "${new_key:-0}" -eq 1 ]] || return 0
  printf '\n%s%s' "$YEL" "$B"
  echo "  WICHTIG: HZ_SECRET_KEY sichern!"
  printf '%s' "$R"
  echo "  Mit diesem Schlüssel sind alle gespeicherten Tokens verschlüsselt (GitHub, Home Assistant,"
  echo "  Agents, RCON). Ohne ihn ist ein Backup der Datenbank wertlos. Er steht in $CORE_ENV"
  echo "  (nur root lesbar). Kopiere ihn in deinen Passwortmanager:"
  echo "      sudo grep ^HZ_SECRET_KEY= $CORE_ENV"
  if [[ $interactive -eq 1 && -w /dev/tty ]] && confirm "Schlüssel jetzt einmal anzeigen?" n; then
    # Straight to the terminal, never into a pipe or log.
    printf '\n      %s\n\n' "$(env_get "$CORE_ENV" HZ_SECRET_KEY)" >/dev/tty
  fi
}

core_install() {
  printf '%sHomelab-Zentrale einrichten%s\n' "$B" "$R"
  info "Ziel: $CONF_DIR. Die Zentrale lauscht nur auf 127.0.0.1 und ist nur über Tailscale erreichbar."
  need_docker
  need_tailscale
  configure_core
  resolve_image
  start_core
  local base
  base="$(env_get "$CORE_ENV" HZ_BASE_URL)"
  setup_serve "${base#https://}"
  if [[ $serve -eq 1 ]] && ! wait_health "$base" 20; then
    warn "$base antwortet noch nicht. Das erste Zertifikat kann eine Minute dauern."
  fi
  show_first_login "$base"
  remind_secret_key
  if [[ $interactive -eq 1 ]] && confirm "Share-Gateway für Freunde ohne Tailscale geplant (öffentlicher Server, optional)?" n; then
    share_hint
  fi
  step "Fertig"
  info "Zentrale:     $base"
  info "Agent hier:   in der Zentrale \"Server hinzufügen\", der Einzeiler installiert den Agent."
  info "Update:       sudo $0 update"
  info "Status:       sudo $0 status"
  info "Entfernen:    sudo $0 uninstall   (Daten bleiben, --purge löscht alles)"
  info "Backup:       Einstellungen -> Backup der Zentrale, dazu HZ_SECRET_KEY aus $CORE_ENV"
}

share_hint() {
  info "Auf dem öffentlichen Server (z. B. der Cloud-VM), in einem Checkout dieses Repos:"
  info "  sudo ./deploy/install.sh share --core-url $(env_get "$CORE_ENV" HZ_BASE_URL) --domain <dein-ddns-name>"
  info "Das Gateway-Token erzeugst du vorher in der Zentrale: Einstellungen -> Share-Gateway."
}

core_update() {
  [[ -f "$CORE_ENV" ]] || die "keine Installation in $CONF_DIR gefunden (zuerst: sudo $0)"
  printf '%sHomelab-Zentrale aktualisieren%s\n' "$B" "$R"
  need_docker
  [[ -n "$(env_get "$CORE_ENV" HZ_SECRET_KEY)" ]] || die "HZ_SECRET_KEY fehlt in $CORE_ENV"
  if [[ $build_local -eq 1 || "$(env_get "$CONF_DIR/.env" HZ_CORE_IMAGE)" == "$LOCAL_IMAGE" ]]; then
    info "Lokaler Build: vorher den Checkout aktualisieren (git pull)."
  fi
  resolve_image
  start_core
  if command -v tailscale >/dev/null 2>&1; then no_funnel; fi
  show_first_login "$(env_get "$CORE_ENV" HZ_BASE_URL)"
  step "Fertig"
  ok "läuft mit $image"
}

core_status() {
  [[ -f "$CORE_ENV" ]] || die "keine Installation in $CONF_DIR gefunden"
  local base
  base="$(env_get "$CORE_ENV" HZ_BASE_URL)"
  step "Container"
  compose ps core || true
  step "Health"
  if wait_health "$CORE_URL_LOCAL" 2; then ok "$CORE_URL_LOCAL/api/health"; else warn "keine Antwort auf $CORE_URL_LOCAL/api/health"; fi
  step "Tailscale"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve status || true
    no_funnel
  else
    warn "tailscale fehlt"
  fi
  info "Adresse: $base"
  info "Image:   $(env_get "$CONF_DIR/.env" HZ_CORE_IMAGE)"
  started_at="$(docker inspect -f '{{.State.StartedAt}}' homelab-zentrale-core-1 2>/dev/null || echo 1970-01-01T00:00:00Z)"
  show_first_login "$base"
}

core_uninstall() {
  [[ -d "$CONF_DIR" ]] || die "keine Installation in $CONF_DIR gefunden"
  printf '%sHomelab-Zentrale entfernen%s\n' "$B" "$R"
  if [[ $purge -eq 1 ]]; then
    warn "--purge löscht die Datenbank (Volume $VOLUME) und HZ_SECRET_KEY. Das lässt sich nicht rückgängig machen."
    if [[ -t 0 ]]; then
      # On a terminal always typed, even with --yes.
      local answer=""
      read -r -p "    Zum Bestätigen LOESCHEN eingeben: " answer || true
      [[ "$answer" == LOESCHEN ]] || die "abgebrochen, nichts gelöscht"
    elif [[ $yes -ne 1 ]]; then
      die "--purge ohne Terminal braucht zusätzlich --yes"
    fi
  else
    confirm "Zentrale stoppen und entfernen (Daten und Schlüssel bleiben)?" j || die "abgebrochen"
  fi
  if command -v tailscale >/dev/null 2>&1; then
    step "tailscale serve ausschalten"
    tailscale serve --https=443 off || warn "tailscale serve war nicht aktiv"
  fi
  step "Container"
  if [[ -f "$CORE_COMPOSE" ]] && command -v docker >/dev/null 2>&1; then
    if [[ $purge -eq 1 ]]; then compose down -v --remove-orphans; else compose down --remove-orphans; fi
  fi
  if [[ $purge -eq 1 ]]; then
    if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
      docker volume rm "$VOLUME" >/dev/null || die "Volume $VOLUME ließ sich nicht löschen; Schlüssel bleibt in $CORE_ENV"
    fi
    rm -rf -- "$CONF_DIR"
    ok "alles gelöscht"
  else
    rm -f -- "$CORE_COMPOSE" "$CONF_DIR/.env"
    ok "entfernt. Daten (Volume $VOLUME) und $CORE_ENV bleiben; erneut installieren mit sudo $0"
  fi
}

# --- share gateway ------------------------------------------------------------
SHARE_ENV="$SHARE_DIR/share.env"
SHARE_COMPOSE="$SHARE_DIR/docker-compose.yml"

share_compose() { (cd "$SHARE_DIR" && docker compose "$@"); }

share_install() {
  printf '%sShare-Gateway einrichten (öffentlicher Server)%s\n' "$B" "$R"
  info "Öffentlich ist danach nur Caddy mit /s/*. Die Zentrale selbst bleibt nur im Tailnet."
  # Token first: before apt/curl could read stdin or inherit the variable.
  local url token
  token="${HZ_SHARE_GATEWAY_TOKEN:-}"
  unset HZ_SHARE_GATEWAY_TOKEN
  if [[ -z "$token" && $token_stdin -eq 1 ]]; then
    IFS= read -r token || true
  elif [[ -z "$token" && $interactive -eq 1 ]]; then
    info "Gateway-Token aus der Zentrale (Einstellungen -> Share-Gateway -> Token erzeugen)."
    IFS= read -r -s -p "    Gateway-Token (leer = bisheriges behalten): " token || true
    echo
  fi
  if [[ -n "$token" && ! "$token" =~ $gateway_token_re ]]; then
    die "das Gateway-Token hat ein ungültiges Format (43 Zeichen)"
  fi
  need_docker
  need_tailscale

  step "Konfiguration ($SHARE_ENV)"
  install -d -m 0700 "$SHARE_DIR"
  url="$core_url_arg"
  if [[ -z "$url" ]]; then url="$(env_get "$SHARE_ENV" HZ_SHARE_CORE_URL)"; fi
  if [[ -z "$url" ]]; then url="$(ask "Adresse der Zentrale (https://<name>.ts.net)" "")"; fi
  url="${url%/}"
  valid_ts_url "$url" || die "die Adresse der Zentrale muss https://<name>.ts.net sein (--core-url)"

  if [[ -z "$token" ]]; then
    [[ -n "$(env_get "$SHARE_ENV" HZ_SHARE_GATEWAY_TOKEN)" ]] || die "Gateway-Token fehlt (HZ_SHARE_GATEWAY_TOKEN, --token-stdin oder Eingabe)"
    ok "Gateway-Token vorhanden (bleibt)"
  else
    env_set "$SHARE_ENV" HZ_SHARE_GATEWAY_TOKEN "$token"
    ok "Gateway-Token gespeichert"
  fi
  token=""
  env_set "$SHARE_ENV" HZ_SHARE_CORE_URL "$url"
  chmod 0600 "$SHARE_ENV"
  ok "HZ_SHARE_CORE_URL=$url"

  [[ -f "$SCRIPT_DIR/docker-compose.share.yml" ]] || die "deploy/docker-compose.share.yml nicht gefunden"
  sed "s#/etc/homelab-share/share.env#$SHARE_ENV#" "$SCRIPT_DIR/docker-compose.share.yml" >"$SHARE_COMPOSE"
  chmod 0644 "$SHARE_COMPOSE"

  local simage="$SHARE_DEFAULT_IMAGE"
  if [[ -n "$image" ]]; then simage="$image"; fi
  if [[ $build_local -eq 0 && -z "$image" && "$(env_get "$SHARE_DIR/.env" HZ_SHARE_IMAGE)" == "$SHARE_LOCAL_IMAGE" ]]; then
    build_local=1
  fi
  if [[ $build_local -eq 1 ]]; then
    [[ -f "$REPO_DIR/deploy/Dockerfile.share" ]] || die "--build-local muss aus einem Checkout des Repos laufen"
    step "Image bauen"
    docker build -f "$REPO_DIR/deploy/Dockerfile.share" -t "$SHARE_LOCAL_IMAGE" "$REPO_DIR"
    simage="$SHARE_LOCAL_IMAGE"
  fi
  printf '# Written by deploy/install.sh. No secrets in this file.\nHZ_SHARE_IMAGE=%s\n' "$simage" >"$SHARE_DIR/.env"
  chmod 0644 "$SHARE_DIR/.env"

  step "Starten"
  if [[ "$simage" != "$SHARE_LOCAL_IMAGE" ]]; then share_compose pull share; fi
  check_hardening "$simage" "$SHARE_COMPOSE" Gateway share
  share_compose up -d --no-build --force-recreate share
  local probe code="" i
  probe="http://127.0.0.1:8090/s/$(printf 'a%.0s' {1..43})"
  for ((i = 0; i < HEALTH_TIMEOUT; i += 2)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$probe" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && break
    sleep 2
  done
  [[ "$code" == 200 ]] || { share_compose logs --tail 30 share >&2 || true; die "das Gateway antwortet nicht auf 127.0.0.1:8090"; }
  ok "Gateway läuft auf 127.0.0.1:8090"

  share_caddy
  step "Fertig"
  info "In der Zentrale: Einstellungen -> Share-Gateway auf \"Aktiv\" stellen und die öffentliche Adresse eintragen."
}

share_caddy() {
  step "Caddy (HTTPS für den öffentlichen Namen)"
  if [[ -z "$domain" && $interactive -eq 1 ]]; then
    domain="$(ask "Öffentlicher DDNS-Name (leer = Caddy überspringen)" "")"
    if [[ -n "$domain" ]]; then
      [[ "$domain" =~ $domain_re && ! "$domain" =~ \.ts\.net$ ]] || die "ungültiger Name: $domain"
    fi
  fi
  if [[ -z "$domain" ]]; then
    info "übersprungen. Anleitung: deploy/README.md, Abschnitt Share-Gateway."
    return 0
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    warn "Caddy ist nicht installiert. Schritte: deploy/README.md (Share-Gateway, Schritt 4), dann erneut ausführen."
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  sed "s#spiel\.example\.duckdns\.org#$domain#g" "$SCRIPT_DIR/Caddyfile.share" >"$tmp"
  if [[ -f "$CADDY_FILE" ]] && ! cmp -s "$tmp" "$CADDY_FILE"; then
    cp -p "$CADDY_FILE" "$CADDY_FILE.bak-$(date +%Y%m%d%H%M%S)"
    info "bisheriges Caddyfile gesichert ($CADDY_FILE.bak-…)"
  fi
  if ! caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    die "das erzeugte Caddyfile ist ungültig (caddy validate), nichts geändert"
  fi
  warn "$CADDY_FILE wird ersetzt (nur die Share-Site). Andere Sites daraus aus der Sicherung übernehmen."
  install -m 0644 "$tmp" "$CADDY_FILE"
  rm -f "$tmp"
  systemctl reload caddy || warn "systemctl reload caddy ist fehlgeschlagen"
  ok "Caddy leitet https://$domain/s/* an das Gateway"
  info "Ports öffnet dieses Skript nicht. Für Let's Encrypt und Freunde müssen TCP 80 und 443 offen sein"
  info "(Cloud-Firewall/Security List und iptables, siehe deploy/README.md). Sonst nichts öffnen, nie 8090."
}

share_status() {
  [[ -f "$SHARE_COMPOSE" ]] || die "kein Share-Gateway in $SHARE_DIR gefunden"
  share_compose ps share || true
  info "Core: $(env_get "$SHARE_ENV" HZ_SHARE_CORE_URL)"
  info "Image: $(env_get "$SHARE_DIR/.env" HZ_SHARE_IMAGE)"
}

share_uninstall() {
  [[ -d "$SHARE_DIR" ]] || die "kein Share-Gateway in $SHARE_DIR gefunden"
  confirm "Share-Gateway stoppen und entfernen (Token-Datei wird gelöscht)?" j || die "abgebrochen"
  if [[ -f "$SHARE_COMPOSE" ]]; then share_compose down --remove-orphans || true; fi
  rm -rf -- "$SHARE_DIR"
  ok "entfernt. Das Token in der Zentrale ungültig machen: Einstellungen -> Share-Gateway -> neues Token."
  info "Caddy und offene Ports bleiben unverändert."
}

# --- main ---------------------------------------------------------------------
new_key=0
started_at="1970-01-01T00:00:00Z"
case "$target:$mode" in
  core:install) core_install ;;
  core:update) core_update ;;
  core:status) core_status ;;
  core:uninstall) core_uninstall ;;
  share:install | share:update) share_install ;;
  share:status) share_status ;;
  share:uninstall) share_uninstall ;;
esac
