#!/usr/bin/env bash
# ============================================================================
# vFusion deploy script
# ============================================================================
# Runs on the docker host. Pulls latest code from GitHub, renders .env from
# .env.tpl using the 1Password service account token, and rebuilds + recreates
# the stack.
#
# Prerequisites on the deploy host:
#   1. `op` (1Password) CLI installed
#   2. /etc/op-token exists (root:docker 0640) with a 1Password service
#      account token scoped to the vault holding this app's secrets.
#   3. This repo cloned somewhere on the host.
#
# Usage (run from anywhere — the script locates its own directory):
#   ./deploy.sh                 # rebuild all services
#   ./deploy.sh backend worker  # rebuild specific services only
# ============================================================================

set -euo pipefail

# Resolve the repo root from the script's own location so this works
# wherever the repo is cloned, with no hardcoded host path.
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="/etc/op-token"
ENV_FILE="${SERVICE_DIR}/.env"
ENV_TEMPLATE="${SERVICE_DIR}/.env.tpl"

SERVICES=("$@")

# ---- Pre-flight checks ----

if ! command -v op >/dev/null 2>&1; then
    echo "ERROR: 'op' CLI not found in PATH." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: 'docker' not found in PATH." >&2
    exit 1
fi

if [[ ! -r "$TOKEN_FILE" ]]; then
    echo "ERROR: ${TOKEN_FILE} is not readable by $(id -un)." >&2
    echo "Expected: root:docker, mode 0640." >&2
    exit 1
fi

if [[ ! -f "$ENV_TEMPLATE" ]]; then
    echo "ERROR: ${ENV_TEMPLATE} not found. Did the git pull succeed?" >&2
    exit 1
fi

# ---- Load service account token ----

export OP_SERVICE_ACCOUNT_TOKEN
OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"

cd "$SERVICE_DIR"

# ---- Pull latest code ----

echo "==> Pulling latest from git..."
git pull --ff-only
echo

# ---- Render .env from template ----

echo "==> Rendering .env from .env.tpl via 1Password..."
op inject --force -i "$ENV_TEMPLATE" -o "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "    wrote $ENV_FILE ($(wc -c < "$ENV_FILE") bytes, mode 600)"
echo

# ---- Rebuild and recreate ----

echo "==> Rebuilding and recreating containers..."
export CACHEBUST="$(date +%s)"
if [[ ${#SERVICES[@]} -gt 0 ]]; then
    docker compose build "${SERVICES[@]}"
    docker compose up -d "${SERVICES[@]}"
else
    docker compose build
    docker compose up -d
fi
echo

# ---- Follow logs ----

echo "==> Deploy complete. Tailing logs (Ctrl+C to exit)..."
echo
if [[ ${#SERVICES[@]} -gt 0 ]]; then
    exec docker compose logs -f --tail=50 "${SERVICES[@]}"
else
    exec docker compose logs -f --tail=50
fi
