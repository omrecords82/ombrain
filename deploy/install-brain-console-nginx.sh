#!/usr/bin/env bash
set -euo pipefail

CONF_SRC="$(cd "$(dirname "$0")" && pwd)/om-brain-console-lan.conf"
CONF_DST="/etc/nginx/sites-available/om-brain-console-lan"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

install -m 0644 "$CONF_SRC" "$CONF_DST"
ln -sf "$CONF_DST" /etc/nginx/sites-enabled/om-brain-console-lan
nginx -t
systemctl reload nginx
echo "Installed om-brain-console nginx edge on 192.168.1.254:8392"
