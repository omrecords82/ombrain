#!/usr/bin/env bash
#
# install-webhook-nginx.sh — enable Fork A §4 webhook nginx on auth01.
# Idempotent. Requires root (sudo).
#
# Usage (on auth01):
#   sudo /opt/om-brain/deploy/install-webhook-nginx.sh
#   # or from repo checkout:
#   sudo om-brain/deploy/install-webhook-nginx.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="${SCRIPT_DIR}/om-brain-webhook.conf"
SITES_AVAILABLE="/etc/nginx/sites-available/om-brain-webhook"
SITES_ENABLED="/etc/nginx/sites-enabled/om-brain-webhook"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[webhook-nginx] ERROR: run as root (sudo)." >&2
  exit 1
fi

if [[ ! -f "${CONF_SRC}" ]]; then
  echo "[webhook-nginx] ERROR: missing ${CONF_SRC}" >&2
  exit 1
fi

echo "[webhook-nginx] installing site config"
install -m 0644 "${CONF_SRC}" "${SITES_AVAILABLE}"
ln -sf "${SITES_AVAILABLE}" "${SITES_ENABLED}"

echo "[webhook-nginx] testing nginx configuration"
nginx -t

echo "[webhook-nginx] reloading nginx"
systemctl reload nginx

echo "[webhook-nginx] verifying localhost health via :8391"
if curl -sf http://127.0.0.1:8391/health >/dev/null; then
  echo "[webhook-nginx] OK — http://127.0.0.1:8391/health reachable"
else
  echo "[webhook-nginx] WARNING: health check failed — is om-brain.service running on :8390?" >&2
  exit 1
fi

echo "[webhook-nginx] done."
echo "[webhook-nginx] NOTE: .242 cannot POST until OMStudio Section 12 wires the webhook URL."
echo "[webhook-nginx]       Expected target: http://192.168.1.254:8391/governance/approvals/:id/ingest-status"
