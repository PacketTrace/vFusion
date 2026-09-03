#!/usr/bin/env bash
# Generate the CA + server certificate the Verkada camera will accept.
#
# The camera validates strictly, and three things trip people up:
#   - the CA must carry basicConstraints=CA:TRUE (LibreSSL's `req -x509`
#     omits it, which reads as "bad certificate" -- macOS ships LibreSSL)
#   - the leaf must carry extendedKeyUsage=serverAuth
#   - the leaf's SAN must contain the exact address in broker_host_port
# All three are set explicitly below rather than left to defaults.
#
# Usage: ./gen-certs.sh <broker-host-or-ip>
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <broker-host-or-ip>   (the address cameras will connect to)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"

# SAN type depends on whether we were handed an IP or a name.
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$HOST"
else
  SAN="DNS:$HOST"
fi

echo "==> CA"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout root_ca.key -out root_ca.pem \
  -subj "/CN=vFusion-MQTT-RootCA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1

echo "==> server key + CSR ($SAN)"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout server.key -out server.csr \
  -subj "/CN=$HOST" >/dev/null 2>&1

cat > server.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EXT

echo "==> sign"
openssl x509 -req -in server.csr -CA root_ca.pem -CAkey root_ca.key \
  -CAcreateserial -out server.pem -days 3650 -sha256 \
  -extfile server.ext >/dev/null 2>&1

cat server.pem root_ca.pem > fullchain.pem
chmod 644 fullchain.pem root_ca.pem server.pem
chmod 600 server.key root_ca.key
rm -f server.csr server.ext

echo
echo "Wrote $DIR:"
echo "  root_ca.pem   <- push THIS to the camera as broker_cert (not the leaf)"
echo "  fullchain.pem <- served by nginx"
echo
echo "SAN is $SAN. If the broker address ever changes, re-run this and"
echo "re-push every camera's config -- the old cert will no longer match."
