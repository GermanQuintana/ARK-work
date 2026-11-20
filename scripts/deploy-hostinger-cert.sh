#!/usr/bin/env bash
# Deploy hook for the *single* mcp-ark-wairua certificate on the shared
# Hostinger VPS. Install to /etc/letsencrypt/renewal-hooks/deploy/ and chmod 700.
# No logs of key contents. Never deploy this on unreviewed infrastructure.
set -euo pipefail
LINEAGE="${RENEWED_LINEAGE:-}"
if [[ "${LINEAGE##*/}" != "mcp-ark-wairua" ]]; then exit 0; fi
CERT_DIR="/root/kit-agente/components/edc/edc-hybrid/proxy-nginx/certs"
CRT="$CERT_DIR/mcp-ark.wairua.xyz.crt"
KEY="$CERT_DIR/mcp-ark.wairua.xyz.key"
[[ -d "$CERT_DIR" ]] || { echo "Certificate volume missing" >&2; exit 1; }
[[ -s "$LINEAGE/fullchain.pem" && -s "$LINEAGE/privkey.pem" ]] || exit 1
# Keep copies to roll back validation failure.
[[ ! -e "$CRT" ]] || install -m 644 "$CRT" "$CRT.prev"
[[ ! -e "$KEY" ]] || install -m 600 "$KEY" "$KEY.prev"
CRT_NEW="$(mktemp "$CERT_DIR/.mcp-crt.XXXXXX")"
KEY_NEW="$(mktemp "$CERT_DIR/.mcp-key.XXXXXX")"
trap 'rm -f "$CRT_NEW" "$KEY_NEW"' EXIT
install -m 644 "$LINEAGE/fullchain.pem" "$CRT_NEW"
install -m 600 "$LINEAGE/privkey.pem" "$KEY_NEW"
mv -f "$CRT_NEW" "$CRT"
mv -f "$KEY_NEW" "$KEY"
if ! docker exec proxy-nginx-hybrid nginx -t; then
  if [[ -s "$CRT.prev" && -s "$KEY.prev" ]]; then
    install -m 644 "$CRT.prev" "$CRT"
    install -m 600 "$KEY.prev" "$KEY"
  fi
  echo "Nginx rejected renewed certificate; restored previous copies" >&2
  exit 1
fi
docker exec proxy-nginx-hybrid nginx -s reload
echo "ARK certificate published and Nginx gracefully reloaded"
