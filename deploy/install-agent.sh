#!/usr/bin/env bash
# Installs or updates the Homelab-Zentrale agent on this server.
#
#   sudo HZ_AGENT_TOKEN=<token> ./deploy/install-agent.sh \
#     --url wss://heimserver.<tailnet>.ts.net/agent --name oracle-a1 \
#     [--image <image> | --build-local] [--allow-terminal] [--tasks] [--smart]
#
# Image: by default the multi-arch image ghcr.io/puffybooy/homelab-agent:latest
# (amd64 + arm64) is pulled. Pin a build with --image ghcr.io/puffybooy/homelab-agent:sha-<short>
# or :v<version>. --build-local (or HZ_BUILD_LOCAL=1) builds the image from this checkout
# instead, as homelab-zentrale/agent:local.
#
# --tasks allows scheduled shell commands from the core (M20, task.exec): sets
# HZ_AGENT_ALLOW_TASKS=1 in agent.env. Like --allow-terminal it is a root shell on
# the host, started by the core; leave it off unless you need "Befehl ausführen".
#
# --smart lets the agent read SMART values of the disks (NAS, M13): it adds
# deploy/docker-compose.agent.smart.yml (read access to the disks, CAP_SYS_RAWIO).
# On a UGREEN NAS (DMI vendor UGREEN) it is switched on automatically.
#
# The token is the one-time enrollment token from the core ("Server hinzufügen").
# Pass it via HZ_AGENT_TOKEN, via --token-stdin, or type it when asked. It is never
# accepted as a command-line argument (it would end up in the shell history and `ps`).
#
# What it does:
#   1. checks Docker and Docker Compose v2,
#   2. creates /opt/homelab (the only directory agent actions may write to),
#   3. writes /etc/homelab-agent/agent.env (mode 0600) and the compose file,
#   4. pulls the image (or builds it with --build-local) and starts the agent.
# The agent opens no port; it connects out to the core over Tailscale.
set -euo pipefail

CONF_DIR=/etc/homelab-agent
HOMELAB_DIR=/opt/homelab
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_IMAGE=homelab-zentrale/agent:local
DEFAULT_IMAGE=ghcr.io/puffybooy/homelab-agent:latest

url=""
name=""
image=""
allow_terminal=0
tasks=0
smart=0
build_local=0
if [[ "${HZ_BUILD_LOCAL:-0}" == 1 ]]; then build_local=1; fi
token_stdin=0

die() {
  echo "Fehler: $*" >&2
  exit 1
}

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    --build-local) build_local=1; shift ;;
    --allow-terminal) allow_terminal=1; shift ;;
    --tasks) tasks=1; shift ;;
    --smart) smart=1; shift ;;
    --token-stdin) token_stdin=1; shift ;;
    --token|--token=*) die "das Token nie als Argument übergeben, sondern über HZ_AGENT_TOKEN oder --token-stdin" ;;
    -h|--help) usage 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || die "bitte als root ausführen (sudo)"

# --- inputs -------------------------------------------------------------------
[[ -n "$url" ]] || die "--url fehlt (z. B. wss://heimserver.<tailnet>.ts.net/agent)"
url_re='^wss?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~-]+)*/agent$'
[[ "$url" =~ $url_re ]] \
  || die "--url muss ws:// oder wss:// sein und auf /agent enden"

[[ -n "$name" ]] || name="$(hostname | tr '[:upper:]' '[:lower:]')"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--name: nur a-z, 0-9 und -, höchstens 63 Zeichen"

if [[ -n "$image" && $build_local -eq 1 ]]; then
  die "--image und --build-local (HZ_BUILD_LOCAL=1) schließen sich aus"
fi
if [[ -n "$image" ]]; then
  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$ ]] || die "--image ist kein gültiger Image-Name"
fi

token="${HZ_AGENT_TOKEN:-}"
if [[ -z "$token" && $token_stdin -eq 1 ]]; then
  IFS= read -r token || true
elif [[ -z "$token" && -t 0 ]]; then
  IFS= read -r -s -p "Enrollment-Token: " token || true
  echo
fi
if [[ -z "$token" && -f "$CONF_DIR/agent.env" ]]; then
  echo "Kein neues Token: die bestehende Konfiguration bleibt, das gespeicherte Agent-Token wird weiter verwendet."
fi
if [[ -n "$token" ]]; then
  [[ "$token" =~ ^[A-Za-z0-9_-]{22,128}$ ]] || die "das Token hat ein ungültiges Format"
fi

# A UGREEN NAS (NASync, UGOS Pro) gets SMART automatically.
if grep -qi ugreen /sys/class/dmi/id/sys_vendor 2>/dev/null \
  || grep -Eqi 'ugreen|dxp[0-9]' /sys/class/dmi/id/product_name 2>/dev/null \
  || grep -qi ugos /etc/os-release 2>/dev/null; then smart=1; fi

# --- docker -------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker fehlt (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "der Docker-Dienst läuft nicht"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 fehlt (Paket docker-compose-plugin)"

# --- files --------------------------------------------------------------------
install -d -m 0755 "$HOMELAB_DIR"
install -d -m 0700 "$CONF_DIR"

old_umask="$(umask)"
umask 077
if [[ -n "$token" || ! -f "$CONF_DIR/agent.env" ]]; then
  [[ -n "$token" ]] || die "Enrollment-Token fehlt (HZ_AGENT_TOKEN oder --token-stdin)"
  tmp="$(mktemp "$CONF_DIR/.agent.env.XXXXXX")"
  {
    echo "# Homelab-Zentrale agent. Written by install-agent.sh. Contains a secret: keep 0600."
    printf 'HZ_CORE_URL=%s\n' "$url"
    printf 'HZ_AGENT_NAME=%s\n' "$name"
    printf 'HZ_AGENT_TOKEN=%s\n' "$token"
    printf 'HZ_AGENT_ALLOW_TERMINAL=%s\n' "$allow_terminal"
    printf 'HZ_AGENT_ALLOW_TASKS=%s\n' "$tasks"
  } >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$CONF_DIR/agent.env"
else
  # Existing configuration without a new token: --allow-terminal / --tasks switch the
  # flag on in place (everything else, including the agent token, stays as it is).
  for flag in HZ_AGENT_ALLOW_TERMINAL:"$allow_terminal" HZ_AGENT_ALLOW_TASKS:"$tasks"; do
    key="${flag%%:*}"
    [[ "${flag#*:}" == 1 ]] || continue
    tmp="$(mktemp "$CONF_DIR/.agent.env.XXXXXX")"
    { grep -v "^${key}=" "$CONF_DIR/agent.env" || true; printf '%s=1\n' "$key"; } >"$tmp"
    chmod 0600 "$tmp"
    mv -f "$tmp" "$CONF_DIR/agent.env"
    echo "$key=1 in $CONF_DIR/agent.env gesetzt."
  done
fi
umask "$old_umask"
unset token HZ_AGENT_TOKEN

[[ -f "$SCRIPT_DIR/docker-compose.agent.yml" ]] || die "deploy/docker-compose.agent.yml nicht gefunden"
install -m 0644 "$SCRIPT_DIR/docker-compose.agent.yml" "$CONF_DIR/docker-compose.yml"
compose_files="docker-compose.yml"
if [[ $smart -eq 1 ]]; then
  [[ -f "$SCRIPT_DIR/docker-compose.agent.smart.yml" ]] || die "deploy/docker-compose.agent.smart.yml nicht gefunden"
  install -m 0644 "$SCRIPT_DIR/docker-compose.agent.smart.yml" "$CONF_DIR/docker-compose.smart.yml"
  compose_files="docker-compose.yml:docker-compose.smart.yml"
else
  rm -f "$CONF_DIR/docker-compose.smart.yml"
fi

if [[ $build_local -eq 1 ]]; then
  [[ -f "$REPO_DIR/apps/agent/Dockerfile" ]] || die "--build-local muss aus einem Checkout des Repos laufen"
  echo "Baue das Agent-Image aus $REPO_DIR ..."
  docker build -f "$REPO_DIR/apps/agent/Dockerfile" -t "$LOCAL_IMAGE" "$REPO_DIR"
  image="$LOCAL_IMAGE"
elif [[ -z "$image" ]]; then
  image="$DEFAULT_IMAGE"
fi

# Interpolation variables for compose (no secrets here).
printf 'HZ_AGENT_IMAGE=%s\nHZ_AGENT_ENV_FILE=%s\nCOMPOSE_FILE=%s\n' "$image" "$CONF_DIR/agent.env" "$compose_files" >"$CONF_DIR/.env"
chmod 0644 "$CONF_DIR/.env"

cd "$CONF_DIR"
if [[ $build_local -eq 0 ]]; then
  echo "Lade $image ..."
  docker compose pull agent
fi
docker compose up -d --no-build --force-recreate agent

echo
echo "Agent \"$name\" läuft. Er erscheint in der Zentrale, sobald er verbunden ist."
echo "Logs:      docker logs -f homelab-agent"
echo "Neustart:  cd $CONF_DIR && docker compose up -d"
echo "Entfernen: cd $CONF_DIR && docker compose down -v"
