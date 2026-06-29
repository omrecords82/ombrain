#!/usr/bin/env bash
#
# install-getbrain.sh — deploy the getbrain bootstrap service on om-prod01 (.239).
#
# Installs the systemd unit, seeds /etc/om-brain/getbrain.env (if absent), and
# drops the nginx location snippet. Idempotent; safe to re-run after deploys.
#
# Usage:
#   sudo bash om-brain/getbrain/install-getbrain.sh [--repo /var/www/omai] \
#        [--pin <PIN>] [--brain-host 192.168.1.254] [--ports 60000-62000] \
#        [--no-nginx] [--uninstall]
#
set -euo pipefail

REPO="/var/www/omai"
PIN=""
BRAIN_HOST="192.168.1.254"
PORTS="60000-62000"
DO_NGINX=1
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    --brain-host) BRAIN_HOST="$2"; shift 2 ;;
    --ports) PORTS="$2"; shift 2 ;;
    --no-nginx) DO_NGINX=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

GB="$REPO/om-brain/getbrain"
ENV=/etc/om-brain/getbrain.env
UNIT=/etc/systemd/system/getbrain.service
NGINX_SNIPPET=/etc/nginx/snippets/getbrain.conf

if [[ "$UNINSTALL" -eq 1 ]]; then
  systemctl disable --now getbrain 2>/dev/null || true
  rm -f "$UNIT" "$NGINX_SNIPPET"
  systemctl daemon-reload || true
  echo "getbrain uninstalled (env left at $ENV; remove manually if desired)"
  exit 0
fi

[[ -f "$GB/server.js" ]] || { echo "error: $GB/server.js not found (check --repo)" >&2; exit 1; }

mkdir -p /etc/om-brain

# --- env -------------------------------------------------------------------
if [[ ! -f "$ENV" ]]; then
  install -m 0600 "$GB/getbrain.env.example" "$ENV"
  sed -i "s|^GETBRAIN_BIND=.*|GETBRAIN_BIND=127.0.0.1|" "$ENV"
  sed -i "s|^GETBRAIN_BRAIN_HOST=.*|GETBRAIN_BRAIN_HOST=$BRAIN_HOST|" "$ENV"
  sed -i "s|^GETBRAIN_BRAIN_PORTS=.*|GETBRAIN_BRAIN_PORTS=$PORTS|" "$ENV"
  if [[ -n "$PIN" ]]; then sed -i "s|^GETBRAIN_PIN=.*|GETBRAIN_PIN=$PIN|" "$ENV"; fi
  echo "wrote $ENV (edit GETBRAIN_PIN before relying on it)"
else
  echo "kept existing $ENV"
  [[ -n "$PIN" ]] && { sed -i "s|^GETBRAIN_PIN=.*|GETBRAIN_PIN=$PIN|" "$ENV"; echo "  updated PIN"; }
fi

# --- systemd unit ----------------------------------------------------------
NODE_BIN="$(command -v node || echo /usr/bin/node)"
sed -e "s|/var/www/omai|$REPO|g" \
    -e "s|ExecStart=/usr/bin/node|ExecStart=$NODE_BIN|" \
    "$GB/getbrain.service" > "$UNIT"
echo "wrote $UNIT (node=$NODE_BIN, repo=$REPO)"

systemctl daemon-reload
systemctl enable --now getbrain
sleep 1
systemctl --no-pager --full status getbrain | head -n 6 || true

# --- nginx -----------------------------------------------------------------
if [[ "$DO_NGINX" -eq 1 ]]; then
  mkdir -p "$(dirname "$NGINX_SNIPPET")"
  cp "$GB/getbrain-nginx.conf" "$NGINX_SNIPPET"
  echo "wrote $NGINX_SNIPPET"
  echo
  echo "ACTION REQUIRED: include the snippet in the orthodoxmetrics.com server block, e.g.:"
  echo "    include /etc/nginx/snippets/getbrain.conf;"
  echo "Then: sudo nginx -t && sudo systemctl reload nginx"
fi

echo
echo "verify (on .239):  curl -s http://127.0.0.1:8395/getbrain/health"
echo "from a workstation: http://orthodoxmetrics.com/getbrain/"
