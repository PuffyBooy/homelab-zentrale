#!/usr/bin/env bash
# Installs or updates the Homelab-Zentrale agent on this server.
#
#   sudo HZ_AGENT_TOKEN=<token> ./deploy/install-agent.sh \
#     --url wss://heimserver.<tailnet>.ts.net/agent --name oracle-a1 [--image <image>] [--allow-terminal]
#
# The token is the one-time enrollment token from the core ("Server hinzufügen").
# Pass it via HZ_AGENT_TOKEN, via --token-stdin, or type it when asked. It is never
# accepted as a command-line argument (it would end up in the shell history and `ps`).
#
# What it does:
#   1. checks Docker and Docker Compose v2,
#   2. creates /opt/homelab (the only directory agent actions may write to),
#   3. writes /etc/homelab-agent/agent.env (mode 0600) and the compose file,
#   4. builds the image from this checkout (or uses --image) and starts the agent.
# The agent opens no port; it connects out to the core over Tailscale.
set -euo pipefail

CONF_DIR=/etc/homelab-agent
HOMELAB_DIR=/opt/homelab
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_IMAGE=homelab-zentrale/agent:local

url=""
name=""
image=""
allow_terminal=0
token_stdin=0

die() {
  echo "Fehler: $*" >&2
  exit 1
}

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="${2:-}"; shift 2 ;;
    --name) name="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    --allow-terminal) allow_terminal=1; shift ;;
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
  } >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$CONF_DIR/agent.env"
fi
umask "$old_umask"
unset token HZ_AGENT_TOKEN

[[ -f "$SCRIPT_DIR/docker-compose.agent.yml" ]] || die "deploy/docker-compose.agent.yml nicht gefunden"
install -m 0644 "$SCRIPT_DIR/docker-compose.agent.yml" "$CONF_DIR/docker-compose.yml"

if [[ -z "$image" ]]; then
  [[ -f "$REPO_DIR/apps/agent/Dockerfile" ]] || die "ohne --image muss das Skript aus einem Checkout des Repos laufen"
  echo "Baue das Agent-Image aus $REPO_DIR ..."
  docker build -f "$REPO_DIR/apps/agent/Dockerfile" -t "$LOCAL_IMAGE" "$REPO_DIR"
  image="$LOCAL_IMAGE"
fi

# Interpolation variables for compose (no secrets here).
printf 'HZ_AGENT_IMAGE=%s\nHZ_AGENT_ENV_FILE=%s\n' "$image" "$CONF_DIR/agent.env" >"$CONF_DIR/.env"
chmod 0644 "$CONF_DIR/.env"

cd "$CONF_DIR"
if [[ "$image" != "$LOCAL_IMAGE" ]]; then
  docker compose pull agent
fi
docker compose up -d --no-build --force-recreate agent

echo
echo "Agent \"$name\" läuft. Er erscheint in der Zentrale, sobald er verbunden ist."
echo "Logs:      docker logs -f homelab-agent"
echo "Neustart:  cd $CONF_DIR && docker compose up -d"
echo "Entfernen: cd $CONF_DIR && docker compose down -v"
