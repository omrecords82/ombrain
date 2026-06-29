#!/usr/bin/env bash
#
# install-brain-lan-nginx.sh — expose om-brain REST API on the LAN (om-dev .254).
#
# Idempotent. Requires root (sudo). Expects om-brain.service on 127.0.0.1:8390.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="${SCRIPT_DIR}/om-brain-lan-api.conf"
SITES_AVAILABLE="/etc/nginx/sites-available/om-brain-lan-api"
SITES_ENABLED="/etc/nginx/sites-enabled/om-brain-lan-api"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[brain-lan-nginx] ERROR: run as root (sudo)." >&2
  exit 1
fi

[[ -f "${CONF_SRC}" ]] || { echo "[brain-lan-nginx] ERROR: missing ${CONF_SRC}" >&2; exit 1; }

install -m 0644 "${CONF_SRC}" "${SITES_AVAILABLE}"
ln -sf "${SITES_AVAILABLE}" "${SITES_ENABLED}"

nginx -t
systemctl reload nginx

if curl -sf http://192.168.1.254:8390/health >/dev/null; then
  echo "[brain-lan-nginx] OK — http://192.168.1.254:8390/health reachable on LAN"
else
  echo "[brain-lan-nginx] WARNING: LAN health check failed" >&2
  exit 1
fi

echo "[brain-lan-nginx] done."
