#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
server=${1:-}
port=${2:-18760}
[[ "$server" == apache || "$server" == nginx ]] || { echo 'Usage: render.sh {apache|nginx} [localhost-port=18760]' >&2; exit 1; }
[[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Port must be 1-65535.' >&2; exit 1; }
port=$((10#$port))
sed "s/__AI_PORT__/$port/g" "$root/$server.conf.template"
