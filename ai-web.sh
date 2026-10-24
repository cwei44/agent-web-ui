#!/usr/bin/env bash
set -euo pipefail
umask 077
bundle=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name=ai-web-portable
image=$(cat "$bundle/IMAGE_ID")
command -v docker >/dev/null || { echo 'Install and start Docker first.' >&2; exit 1; }
docker info >/dev/null
mounts=(-v "$bundle/data:/data" -v "$bundle/workspace:/workspace")

init() {
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker load -i "$bundle/image-linux-amd64.tar.gz"
  fi
  mkdir -p "$bundle/data" "$bundle/workspace"
  docker run --rm --user 0 "${mounts[@]}" "$image" sh -c \
    'mkdir -p /data/codex/codex /data/codex/home /data/claude/claude /data/claude/home /data/home; chown 1000:1000 /data /data/codex /data/codex/codex /data/codex/home /data/claude /data/claude/claude /data/claude/home /data/home /workspace; chmod 700 /data /data/codex /data/claude'
  if [[ ! -f "$bundle/web.env" ]]; then
    password=$(docker run --rm "$image" node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
    printf 'AI_WEB_USERNAME=admin\nAI_WEB_PASSWORD=%s\nWEB_PORT=8082\nBIND_ADDRESS=127.0.0.1\nAI_WEB_PROVIDERS=both\n' "$password" > "$bundle/web.env"
    unset password
    echo 'Created web.env with a random web password. Keep this file private.'
  fi
}

exists() { docker container inspect "$name" >/dev/null 2>&1; }
owned() {
  local owner
  owner=$(docker inspect --format '{{index .Config.Labels "ai-web.bundle"}}' "$name")
  [[ "$owner" == "$bundle" ]] || { echo "Container $name belongs to a different folder. Stop it from its original folder first." >&2; exit 1; }
}

case "${1:-help}" in
  setup)
    shift
    exec python3 "$bundle/setup-web.py" --bundle "$bundle" "$@"
    ;;
  init)
    init
    echo 'Next: ./ai-web.sh login codex; ./ai-web.sh login claude; ./ai-web.sh start'
    ;;
  proxy-setup)
    port=${2:-18760}
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Port must be 1-65535.' >&2; exit 1; }
    port=$((10#$port))
    if exists; then
      owned
      echo 'Run ./ai-web.sh stop first so the container can be recreated with its private port.' >&2
      exit 1
    fi
    init
    temporary=$(mktemp "$bundle/.web.env.XXXXXX")
    trap 'rm -f -- "$temporary"' EXIT
    sed -e '/^BIND_ADDRESS=/d' -e '/^WEB_PORT=/d' "$bundle/web.env" > "$temporary"
    printf 'BIND_ADDRESS=127.0.0.1\nWEB_PORT=%s\n' "$port" >> "$temporary"
    mv -- "$temporary" "$bundle/web.env"
    trap - EXIT
    "$bundle/proxy/render.sh" apache "$port" > "$bundle/proxy/apache.conf"
    "$bundle/proxy/render.sh" nginx "$port" > "$bundle/proxy/nginx.conf"
    echo "AI Web will listen privately on 127.0.0.1:$port. Existing credentials were preserved."
    echo 'Generated proxy/apache.conf and proxy/nginx.conf. Include the appropriate one in your existing virtual host/server block.'
    echo 'Next: ./ai-web.sh login codex / login claude (first use), then ./ai-web.sh start. See proxy/README.txt for web-server setup.'
    ;;
  login)
    provider=${2:-}
    [[ "$provider" == codex || "$provider" == claude ]] || { echo 'Usage: ./ai-web.sh login {codex|claude}' >&2; exit 1; }
    if exists; then owned; fi
    init
    if [[ "$provider" == codex ]]; then
      docker run --rm -it --env-file "$bundle/web.env" -e HOME=/data/codex/home "${mounts[@]}" "$image" codex login --device-auth
    else
      docker run --rm -it --env-file "$bundle/web.env" -e HOME=/data/claude/home "${mounts[@]}" "$image" claude auth login
    fi
    if exists; then echo 'Login saved. When idle, run stop then start to reload the login in the web UI.'; fi
    ;;
  start)
    if exists; then owned; fi
    requested=${2:-}
    [[ -z "$requested" || "$requested" == both || "$requested" == codex || "$requested" == claude ]] || { echo 'Choose both, codex or claude.' >&2; exit 1; }
    if [[ -n "$requested" ]] && exists; then
      current=$(docker inspect --format '{{index .Config.Labels "ai-web.providers"}}' "$name")
      [[ "$current" == "$requested" ]] || { echo 'Run stop before changing providers.' >&2; exit 1; }
    fi
    init
    if [[ -n "$requested" ]]; then
      temporary=$(mktemp "$bundle/.web.env.XXXXXX")
      sed '/^AI_WEB_PROVIDERS=/d' "$bundle/web.env" > "$temporary"
      printf 'AI_WEB_PROVIDERS=%s\n' "$requested" >> "$temporary"
      mv -- "$temporary" "$bundle/web.env"
    fi
    providers=$(sed -n 's/^AI_WEB_PROVIDERS=//p' "$bundle/web.env")
    [[ "$providers" == both || "$providers" == codex || "$providers" == claude ]] || { echo 'AI_WEB_PROVIDERS must be both, codex or claude.' >&2; exit 1; }
    port=$(sed -n 's/^WEB_PORT=//p' "$bundle/web.env")
    bind=$(sed -n 's/^BIND_ADDRESS=//p' "$bundle/web.env")
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || { echo 'WEB_PORT must be 1-65535.' >&2; exit 1; }
    [[ "$bind" == 127.0.0.1 || "$bind" == 0.0.0.0 ]] || { echo 'BIND_ADDRESS must be 127.0.0.1 or 0.0.0.0.' >&2; exit 1; }
    if exists; then
      owned
      current=$(docker inspect --format '{{index .Config.Labels "ai-web.providers"}}' "$name")
      [[ "$current" == "$providers" ]] || { echo 'Run stop before changing providers.' >&2; exit 1; }
      docker start "$name" >/dev/null
    else
      docker run -d --name "$name" --label "ai-web.bundle=$bundle" --label "ai-web.providers=$providers" \
        --restart unless-stopped --env-file "$bundle/web.env" \
        -p "$bind:$port:8760" "${mounts[@]}" "$image" >/dev/null
    fi
    healthy=false
    for attempt in {1..30}; do
      if docker exec "$name" node /suite/healthcheck.js >/dev/null 2>&1; then healthy=true; break; fi
      sleep 1
    done
    [[ "$healthy" == true ]] || { docker logs --tail 30 "$name"; echo 'Startup failed. See logs above.' >&2; exit 1; }
    echo "Open http://localhost:$port/ai/ on the Docker host."
    if [[ "$bind" == 0.0.0.0 ]]; then echo "Remote access: http://<server-ip>:$port/ai/"; fi
    if [[ -f "$bundle/proxy/apache.conf" || -f "$bundle/proxy/nginx.conf" ]]; then echo 'After installing the proxy include, open your existing website at /ai/.'; fi
    echo 'Web username and password are in web.env.'
    echo 'Provider sign-in: ./ai-web.sh login codex or ./ai-web.sh login claude'
    ;;
  stop)
    if exists; then owned; docker stop "$name" >/dev/null; docker rm "$name" >/dev/null; fi
    echo 'Stopped. Login, history, uploads and workspace remain in this folder.'
    ;;
  status)
    if exists; then owned; docker inspect --format 'Status: {{.State.Status}} | Health: {{.State.Health.Status}}' "$name"; else echo 'Stopped'; fi
    ;;
  logs)
    owned
    docker logs --tail 100 "$name"
    ;;
  *)
    echo 'Usage: ./ai-web.sh {setup|init|login {codex|claude}|start [both|codex|claude]|stop|status|logs|proxy-setup [port]}'
    echo 'First use on port 80: login codex, login claude, then setup (requires Python 3)'
    echo 'setup reuses active httpd.service, or starts the bundled server directly on free port 80.'
    echo 'Reuse existing HTTP/HTTPS: ./ai-web.sh proxy-setup [localhost-port=18760]'
    ;;
esac
