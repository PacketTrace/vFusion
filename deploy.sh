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

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: 'docker' not found in PATH." >&2
    exit 1
fi

# The 1Password path is optional. A host that manages .env by hand (the
# common case if you don't use a secrets manager) just needs the .env to
# exist — only the templated path needs `op` and the service-account token.
USE_OP=0
if [[ -f "$ENV_TEMPLATE" ]]; then
    USE_OP=1
    if ! command -v op >/dev/null 2>&1; then
        echo "ERROR: ${ENV_TEMPLATE} exists but the 'op' CLI is not in PATH." >&2
        echo "Install the 1Password CLI, or delete .env.tpl and manage .env by hand." >&2
        exit 1
    fi
    if [[ ! -r "$TOKEN_FILE" ]]; then
        echo "ERROR: ${TOKEN_FILE} is not readable by $(id -un)." >&2
        echo "Expected: root:docker, mode 0640." >&2
        exit 1
    fi
elif [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: neither ${ENV_TEMPLATE} nor ${ENV_FILE} exists." >&2
    echo "Create .env (copy .env.example and fill it in), or add a .env.tpl" >&2
    echo "with 1Password secret references to have this script render it." >&2
    exit 1
fi

# ---- Load service account token ----

if [[ "$USE_OP" -eq 1 ]]; then
    export OP_SERVICE_ACCOUNT_TOKEN
    OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
fi

cd "$SERVICE_DIR"

# ---- Pull latest code ----

echo "==> Pulling latest from git..."
git pull --ff-only
echo

# ---- Render .env from template ----

if [[ "$USE_OP" -eq 1 ]]; then
    echo "==> Rendering .env from .env.tpl via 1Password..."
    op inject --force -i "$ENV_TEMPLATE" -o "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "    wrote $ENV_FILE ($(wc -c < "$ENV_FILE") bytes, mode 600)"
else
    echo "==> No .env.tpl — using the existing $ENV_FILE as-is."
    chmod 600 "$ENV_FILE"
fi
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
