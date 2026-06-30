#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${OMBRAIN_CONSOLE_HOST:-next@192.168.1.254}"
DEST="${OMBRAIN_CONSOLE_DEST:-/opt/om-brain-console}"

echo "==> Building web UI"
cd "$ROOT"
npm install --prefix web --no-audit --no-fund
npm run build --prefix web

echo "==> Syncing to $REMOTE:$DEST"
ssh "$REMOTE" "sudo mkdir -p '$DEST' && sudo chown -R \$(whoami):\$(whoami) '$DEST'"
rsync -az --delete \
  --exclude node_modules \
  --exclude web/node_modules \
  --exclude .git \
  "$ROOT/" "$REMOTE:$DEST/"

echo "==> Installing server deps on remote"
ssh "$REMOTE" "cd '$DEST' && npm install --omit=dev --no-audit --no-fund"

echo "==> Installing systemd + env (if missing)"
ssh "$REMOTE" "sudo install -m 0644 '$DEST/deploy/om-brain-console.service' /etc/systemd/system/om-brain-console.service"
ssh "$REMOTE" "test -f /etc/om-brain/console.env || sudo install -m 0640 '$DEST/deploy/console.env.example' /etc/om-brain/console.env"
ssh "$REMOTE" "sudo systemctl daemon-reload && sudo systemctl enable om-brain-console && sudo systemctl restart om-brain-console"

echo "==> Installing nginx edge (if script present)"
ssh "$REMOTE" "sudo bash '$DEST/deploy/install-brain-console-nginx.sh'" || true

echo "==> Health check"
curl -sf "http://192.168.1.254:8392/health" | head -c 400 || echo "(LAN edge pending nginx reload)"
echo
echo "Deploy complete: http://192.168.1.254:8392"
