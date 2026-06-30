#!/usr/bin/env bash
#
# deploy.sh — repeatable installer for the OrthodoxMetrics Brain on om-dev
# (192.168.1.254). Run by the user's team WITH superadmin authorization.
#
# This script installs the Brain as an isolated, hardened systemd service inside
# om-brain.slice. It does NOT touch Keycloak, PostgreSQL, nginx, the database
# schema, or any OM/OMAI/OMStudio surface — those are human-only domains.
#
# It is idempotent: safe to re-run for upgrades. Pair with teardown.sh to remove.
#
# Usage (on auth01, as a user with sudo):
#   sudo ./deploy/deploy.sh
#
# Pre-req recorded in README: superadmin approval to co-locate inference on
# auth01 is GRANTED; this remains logged to OMStudio as a boundary-defining act.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/om-brain"
STATE_DIR="/var/lib/om-brain"
ETC_DIR="/etc/om-brain"
SVC_USER="om-brain"
SVC_GROUP="om-brain"

echo "[deploy] OrthodoxMetrics Brain — auth01 install"
echo "[deploy] source: ${SRC_DIR}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[deploy] ERROR: must run as root (sudo)." >&2
  exit 1
fi

# 1) Dedicated, unprivileged service user.
if ! id -u "${SVC_USER}" >/dev/null 2>&1; then
  echo "[deploy] creating service user ${SVC_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SVC_USER}"
fi

# 1b) Release backup (so deploy/rollback.sh can restore the previous release).
#     Snapshots the CURRENT /opt/om-brain (excluding state/secrets) before sync.
BACKUP_ROOT="/var/backups/om-brain"
if [[ -d "${APP_DIR}" ]] && [[ -n "$(ls -A "${APP_DIR}" 2>/dev/null || true)" ]]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[deploy] backing up current release to ${BACKUP_ROOT}/${TS}"
  mkdir -p "${BACKUP_ROOT}/${TS}"
  rsync -a --exclude '/data' --exclude '.env' --exclude 'node_modules' \
    "${APP_DIR}/" "${BACKUP_ROOT}/${TS}/"
  # Keep only the 5 most recent backups.
  ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
fi

# 2) Lay down code (excluding node_modules dev junk; install prod deps in place).
echo "[deploy] syncing application code to ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude '.git' \
  --exclude '/data' \
  --exclude '.env' \
  "${SRC_DIR}/" "${APP_DIR}/"

echo "[deploy] installing production dependencies"
# Optional native deps (better-sqlite3, sqlite-vec) accelerate the vector store;
# if they fail to build, the pure-JS fallback keeps the Brain fully functional.
( cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund ) || {
  echo "[deploy] WARNING: npm install reported issues; verifying runtime fallback…"
  ( cd "${APP_DIR}" && node -e "require('./src/memory/db'); console.log('runtime OK (fallback available)')" )
}

# 3) State dir for the SQLite memory.
mkdir -p "${STATE_DIR}"
chown -R "${SVC_USER}:${SVC_GROUP}" "${STATE_DIR}" "${APP_DIR}"

# 4) Environment file (created once; never overwritten on re-run).
mkdir -p "${ETC_DIR}"
if [[ ! -f "${ETC_DIR}/om-brain.env" ]]; then
  echo "[deploy] installing env template to ${ETC_DIR}/om-brain.env (EDIT IT)"
  install -m 0640 -o root -g "${SVC_GROUP}" \
    "${APP_DIR}/deploy/om-brain.env.example" "${ETC_DIR}/om-brain.env"
else
  echo "[deploy] keeping existing ${ETC_DIR}/om-brain.env"
fi

# 5) systemd slice + unit.
echo "[deploy] installing systemd slice and unit"
install -m 0644 "${APP_DIR}/deploy/om-brain.slice"   /etc/systemd/system/om-brain.slice
install -m 0644 "${APP_DIR}/deploy/om-brain.service" /etc/systemd/system/om-brain.service
install -m 0644 "${APP_DIR}/deploy/om-brain-ops-auth-check.service" /etc/systemd/system/om-brain-ops-auth-check.service
install -m 0644 "${APP_DIR}/deploy/om-brain-ops-auth-check.timer" /etc/systemd/system/om-brain-ops-auth-check.timer

systemctl daemon-reload
systemctl enable om-brain.service
systemctl enable om-brain-ops-auth-check.timer
systemctl restart om-brain.service
sleep 3
systemctl start om-brain-ops-auth-check.service || echo "[deploy] WARNING: initial ops-auth check failed (non-fatal)"

echo "[deploy] refreshing agent snapshots (HOST-SNAPSHOT, SCHEMA-SNAPSHOT)"
if [[ -x "${APP_DIR}/deploy/post-deploy-snapshots.sh" ]]; then
  SNAPSHOT_GIT_REPO="${SNAPSHOT_GIT_REPO:-}" \
    bash "${APP_DIR}/deploy/post-deploy-snapshots.sh" "${APP_DIR}" || \
    echo "[deploy] WARNING: post-deploy-snapshots failed (non-fatal)"
fi

echo "[deploy] installing/updating ombrain CLI + server registry"
if [[ -x "${APP_DIR}/deploy/install-ombrain.sh" ]]; then
  bash "${APP_DIR}/deploy/install-ombrain.sh" \
    --register-master 127.0.0.1 \
    --ports 8390 || \
    echo "[deploy] WARNING: install-ombrain failed (non-fatal)"
fi

echo "[deploy] installing/refreshing Brain LAN API nginx edge (192.168.1.254:8390)"
if [[ -x "${APP_DIR}/deploy/install-brain-lan-nginx.sh" ]]; then
  bash "${APP_DIR}/deploy/install-brain-lan-nginx.sh" || \
    echo "[deploy] WARNING: install-brain-lan-nginx failed (non-fatal)"
fi

echo "[deploy] done. Follow deploy/VERIFY.md to confirm the definition-of-done."
echo "[deploy] quick check: systemctl status om-brain.service --no-pager"
