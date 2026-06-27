#!/usr/bin/env bash
# seed-theology.sh — run all Tier 4 theology seed scripts on auth01.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/om-brain}"
export BRAIN_DB_PATH="${BRAIN_DB_PATH:-/var/lib/om-brain/brain.db}"

cd "${APP_DIR}"
for script in seed-beliefs seed-catechism seed-councils seed-liturgy seed-lxx seed-nt seed-fathers seed-saints; do
  echo "[theology] running ${script}.js"
  node "scripts/theology/${script}.js"
done

echo "[theology] running embed-theology.js"
node scripts/theology/embed-theology.js

echo "[theology] done."
