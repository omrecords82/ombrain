#!/usr/bin/env bash
#
# Install the current (or specified) git checkout into the .254 runtime dirs.
# Does not overwrite /etc/om-brain env files or /var/lib/om-brain state.
#
# Usage (on omdev, as root):
#   sudo /var/www/ombrain/deploy/sync-runtime-on-dev.sh [git-ref]
#
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[sync] ERROR: must run as root (sudo)." >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/om-brain"
CONSOLE_DIR="/opt/om-brain-console"
BACKUP_ROOT="/var/backups/om-brain"
REF="${1:-}"

if [[ ! -d "${SRC_DIR}/.git" ]]; then
  echo "[sync] ERROR: ${SRC_DIR} is not a git checkout." >&2
  exit 1
fi

if [[ -n "${REF}" ]]; then
  echo "[sync] checking out ${REF} in ${SRC_DIR}"
  git -C "${SRC_DIR}" fetch origin --tags
  git -C "${SRC_DIR}" checkout "${REF}"
fi

VERSION="$(tr -d '[:space:]' < "${SRC_DIR}/VERSION" 2>/dev/null || echo unknown)"
GIT_SHA="$(git -C "${SRC_DIR}" rev-parse --short HEAD)"
echo "[sync] source ${SRC_DIR} version=${VERSION} sha=${GIT_SHA}"

if [[ -d "${APP_DIR}" ]] && [[ -n "$(ls -A "${APP_DIR}" 2>/dev/null || true)" ]]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[sync] backing up ${APP_DIR} to ${BACKUP_ROOT}/${TS}"
  mkdir -p "${BACKUP_ROOT}/${TS}"
  rsync -a --exclude '/data' --exclude '.env' --exclude 'node_modules' \
    "${APP_DIR}/" "${BACKUP_ROOT}/${TS}/"
  ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
fi

echo "[sync] syncing service → ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude '.git' \
  --exclude '/data' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'om-brain-console' \
  --exclude 'inventory' \
  "${SRC_DIR}/" "${APP_DIR}/"

echo "[sync] installing service production dependencies"
( cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund ) || {
  echo "[sync] WARNING: npm install reported issues; verifying runtime fallback…"
  ( cd "${APP_DIR}" && node -e "require('./src/memory/db'); console.log('runtime OK (fallback available)')" )
}

chown -R om-brain:om-brain "${APP_DIR}"

if [[ -d "${SRC_DIR}/om-brain-console" ]]; then
  echo "[sync] syncing console → ${CONSOLE_DIR}"
  mkdir -p "${CONSOLE_DIR}"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'web/node_modules' \
    "${SRC_DIR}/om-brain-console/" "${CONSOLE_DIR}/"
  chown -R next:next "${CONSOLE_DIR}"
  ( cd "${CONSOLE_DIR}" && npm install --omit=dev --no-audit --no-fund ) || \
    echo "[sync] WARNING: console npm install reported issues"
fi

systemctl daemon-reload
systemctl restart om-brain.service
if systemctl list-unit-files om-brain-console.service >/dev/null 2>&1; then
  systemctl restart om-brain-console.service
fi

sleep 2
systemctl is-active om-brain.service
systemctl is-active om-brain-console.service || true
echo "[sync] done. version=${VERSION} sha=${GIT_SHA}"
echo "[sync] health: curl -sS http://127.0.0.1:8390/health"
