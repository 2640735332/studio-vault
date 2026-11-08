#!/usr/bin/env bash
# Start Vault in local dev mode (memory store, non-durable) and print the health URL.
# Usage: ./scripts/start-dev.sh [port]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-${VAULT_PORT:-3460}}"
export VAULT_DB="${VAULT_DB:-memory}"
export VAULT_BIND="${VAULT_BIND:-127.0.0.1}"
export VAULT_PORT="$PORT"
echo "[vault] dev mode: http://127.0.0.1:$PORT/api/v1/health (memory store, non-durable)" >&2
echo "[vault] seeded demo projects: demo-project, demo-b" >&2
echo "[vault] dev tokens: vt_devtokena_dev-secret-a (admin demo-project) | vt_devtokenb_dev-secret-b (writer demo-b) | vt_devtokenm_dev-secret-m (admin both)" >&2
echo "[vault] memory mode cannot create durable tokens; stop with Ctrl+C" >&2
exec node "$HERE/../src/server.mjs"