#!/usr/bin/env bash
#
# post-deploy-snapshots.sh — refresh committed agent snapshots after om-brain deploy.
# Run on om-dev (.254) at end of deploy.sh (or via systemd timer).
#
# - collect-hosts.js → inventory/HOST-SNAPSHOT.md (must run ON om-dev for :8390 truth)
# - dump-schema.js → db/SCHEMA-SNAPSHOT.md (when brain.db exists)
#
# Optional git commit when SNAPSHOT_GIT_REPO points at a checkout (e.g. /var/www/omai on .239).

set -euo pipefail

APP_DIR="${1:-/opt/om-brain}"
GIT_REPO="${SNAPSHOT_GIT_REPO:-}"
RUNNER="$(hostname -f 2>/dev/null || hostname)"

echo "[post-deploy-snapshots] app=${APP_DIR} runner=${RUNNER}"

if [[ ! -d "${APP_DIR}/scripts" ]]; then
  echo "[post-deploy-snapshots] ERROR: missing ${APP_DIR}/scripts" >&2
  exit 1
fi

cd "${APP_DIR}"

if [[ -f scripts/collect-hosts.js && -f inventory/hosts.json ]]; then
  echo "[post-deploy-snapshots] running collect-hosts.js"
  node scripts/collect-hosts.js
else
  echo "[post-deploy-snapshots] skip collect-hosts (script or hosts.json missing)"
fi

if [[ -f scripts/dump-schema.js ]]; then
  if [[ -f "${BRAIN_DB_PATH:-/var/lib/om-brain/brain.db}" ]] || [[ -f data/brain.db ]]; then
    echo "[post-deploy-snapshots] running dump-schema.js"
    node scripts/dump-schema.js || echo "[post-deploy-snapshots] dump-schema skipped (no db?)"
  fi
fi

sync_to_git_repo() {
  local repo="$1"
  if [[ -z "$repo" || ! -d "$repo/.git" ]]; then
    echo "[post-deploy-snapshots] SNAPSHOT_GIT_REPO unset or not a git repo — snapshot local only"
    return 0
  fi

  local host_snap="${APP_DIR}/inventory/HOST-SNAPSHOT.md"
  local schema_snap="${APP_DIR}/db/SCHEMA-SNAPSHOT.md"

  if [[ -f "$host_snap" ]]; then
    mkdir -p "${repo}/om-brain/inventory"
    cp "$host_snap" "${repo}/om-brain/inventory/HOST-SNAPSHOT.md"
  fi
  if [[ -f "$schema_snap" ]]; then
    mkdir -p "${repo}/om-brain/db"
    cp "$schema_snap" "${repo}/om-brain/db/SCHEMA-SNAPSHOT.md"
  fi

  cd "$repo"
  git add om-brain/inventory/HOST-SNAPSHOT.md om-brain/db/SCHEMA-SNAPSHOT.md 2>/dev/null || true
  if git diff --staged --quiet; then
    echo "[post-deploy-snapshots] git repo unchanged"
    return 0
  fi

  git commit -m "chore(om-brain): refresh HOST/SCHEMA snapshots from ${RUNNER} post-deploy"
  if git push origin HEAD:main 2>/dev/null; then
    echo "[post-deploy-snapshots] pushed snapshot commit to main"
  else
    echo "[post-deploy-snapshots] committed locally; push manually if needed"
  fi
}

sync_to_git_repo "${GIT_REPO}"

echo "[post-deploy-snapshots] done"
