#!/bin/sh
# Writes the one thing about the dashboard that cannot be baked in.
#
# Vite inlines import.meta.env at build time, so a published image
# cannot carry a per-deployment API address. Rather than build an image
# per install, the bundle reads window.__VFUSION_API_BASE__ first and
# this writes it at container start.
#
# The default is an empty string, meaning "same origin" — every request
# goes to the nginx in front of the bundle, which proxies /api to the
# backend. Set VFUSION_API_BASE only when the backend is genuinely
# somewhere else, and expect to configure CORS on it if you do.
set -eu

CONFIG=/usr/share/nginx/html/config.js
BASE="${VFUSION_API_BASE:-}"

# JSON-encode by hand: this is one string in a shell with no jq, and an
# unescaped quote here would break the whole app rather than one field.
ESCAPED=$(printf '%s' "$BASE" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > "$CONFIG" <<EOF
window.__VFUSION_API_BASE__ = "${ESCAPED}";
EOF

echo "vfusion: API base is \"${BASE}\"${BASE:+ (cross-origin — CORS_ORIGINS must allow this dashboard)}"
