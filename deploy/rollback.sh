#!/usr/bin/env bash
#
# rollback.sh — roll the OrthodoxMetrics Brain on auth01 back to the previous
# released code while leaving all human-only domains untouched.
#
# Strategy: deploy.sh keeps a timestamped backup of the previous /opt/om-brain
# before each sync (see deploy.sh release-backup step). rollback.sh restores the
# most recent backup and restarts the service. It NEVER touches Keycloak,
# PostgreSQL, nginx, the DB schema, secrets, or any OM/OMAI/OMStudio surface.
#
# Usage (on auth01, as a user with sudo):
#   sudo ./deploy/rollback.sh            # roll back to most recent backup
#   sudo ./deploy/rollback.sh <dir>      # roll back to a specific backup dir
#
# This is operational recovery, not a boundary/auth change. Still log the action
# to OMStudio for audit.

set -euo pipefail

APP_DIR="/opt/om-brain"
BACKUP_ROOT="/var/backups/om-brain"
SVC="om-brain.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[rollback] ERROR: must run as root (sudo)." >&2
  exit 1
fi

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  TARGET="$(ls -1dt "${BACKUP_ROOT}"/* 2>/dev/null | head -n1 || true)"
fi

if [[ -z "${TARGET}" || ! -d "${TARGET}" ]]; then
  echo "[rollback] ERROR: no backup found under ${BACKUP_ROOT}." >&2
  echo "[rollback] (deploy.sh creates backups before each release.)" >&2
  exit 1
fi

echo "[rollback] restoring ${TARGET} -> ${APP_DIR}"
rsync -a --delete \
  --exclude '/data' \
  --exclude '.env' \
  "${TARGET}/" "${APP_DIR}/"

# Refresh unit/slice from the restored code (in case they changed).
install -m 0644 "${APP_DIR}/deploy/om-brain.slice"   /etc/systemd/system/om-brain.slice
install -m 0644 "${APP_DIR}/deploy/om-brain.service" /etc/systemd/system/om-brain.service

systemctl daemon-reload
systemctl restart "${SVC}"

echo "[rollback] done. Verify with: sudo ./deploy/verify-smoke.sh"
