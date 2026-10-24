#!/usr/bin/env bash
set -euo pipefail
umask 077
bundle=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name=claude-web-portable
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
    'mkdir -p /data/claude /data/home; chown 1000:1000 /data /data/claude /data/home /workspace; chmod 700 /data /data/claude /data/home'
  if [[ ! -f "$bundle/web.env" ]]; then
    password=$(docker run --rm "$image" node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
    printf 'CLAUDE_WEB_USERNAME=admin\nCLAUDE_WEB_PASSWORD=%s\nWEB_PORT=8081\nBIND_ADDRESS=127.0.0.1\n' "$password" > "$bundle/web.env"
    unset password
    echo 'Created web.env with a random web password. Keep this file private.'
  fi
}

exists() { docker container inspect "$name" >/dev/null 2>&1; }
owned() {
  local owner
  owner=$(docker inspect --format '{{index .Config.Labels "claude-web.bundle"}}' "$name")
  [[ "$owner" == "$bundle" ]] || { echo "Container $name belongs to a different folder. Stop it from its original folder first." >&2; exit 1; }
}

case "${1:-help}" in
  init)
    init
    echo 'Bundle initialized. Next: ./claude-web.sh login, then ./claude-web.sh start'
    ;;
  proxy-setup)
    port=${2:-18766}
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Port must be 1-65535.' >&2; exit 1; }
    port=$((10#$port))
    if exists; then
      owned
      echo 'Run ./claude-web.sh stop first so the container can be recreated with its private port.' >&2
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
    echo "Claude will listen privately on 127.0.0.1:$port. Existing credentials were preserved."
    echo 'Generated proxy/apache.conf and proxy/nginx.conf. Include the appropriate one in your existing virtual host/server block.'
    echo 'Next: ./claude-web.sh login (first use), then ./claude-web.sh start. See proxy/README.txt for web-server setup.'
    ;;
  login)
    init
    docker run --rm -it --env-file "$bundle/web.env" "${mounts[@]}" "$image" claude auth login
    if exists; then owned; docker restart "$name" >/dev/null; fi
    ;;
  start)
    init
    port=$(sed -n 's/^WEB_PORT=//p' "$bundle/web.env")
    bind=$(sed -n 's/^BIND_ADDRESS=//p' "$bundle/web.env")
    [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || { echo 'WEB_PORT must be 1-65535.' >&2; exit 1; }
    [[ "$bind" == 127.0.0.1 || "$bind" == 0.0.0.0 ]] || { echo 'BIND_ADDRESS must be 127.0.0.1 or 0.0.0.0.' >&2; exit 1; }
    if exists; then
      owned
      docker start "$name" >/dev/null
    else
      docker run -d --name "$name" --label "claude-web.bundle=$bundle" \
        --restart unless-stopped --env-file "$bundle/web.env" \
        -p "$bind:$port:8766" "${mounts[@]}" "$image" >/dev/null
    fi
    healthy=false
    for attempt in {1..30}; do
      if docker exec "$name" node /app/healthcheck.js >/dev/null 2>&1; then healthy=true; break; fi
      sleep 1
    done
    [[ "$healthy" == true ]] || { docker logs --tail 30 "$name"; echo 'Startup failed. See logs above.' >&2; exit 1; }
    echo "Open http://localhost:$port/claude/ on the Docker host."
    if [[ "$bind" == 0.0.0.0 ]]; then echo "Remote access: http://<server-ip>:$port/claude/"; fi
    if [[ -f "$bundle/proxy/apache.conf" || -f "$bundle/proxy/nginx.conf" ]]; then echo 'After installing the proxy include, open your existing website at /claude/.'; fi
    echo 'Web username and password are in web.env.'
    if ! docker exec "$name" claude auth status >/dev/null 2>&1; then
      echo 'Claude still needs sign-in: run ./claude-web.sh login'
    fi
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
    echo 'Usage: ./claude-web.sh {init|proxy-setup [port]|login|start|stop|status|logs}'
    echo 'First use: ./claude-web.sh login, then ./claude-web.sh start'
    echo 'Reuse existing HTTP/HTTPS: ./claude-web.sh proxy-setup [localhost-port=18766]'
    ;;
esac
