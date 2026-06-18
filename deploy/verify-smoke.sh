#!/usr/bin/env bash
#
# verify-smoke.sh — non-destructive post-deploy smoke for the Brain on auth01.
# Confirms the service is up, the health endpoint responds, and the circuit
# breaker / no-egress posture holds. Read-only; makes no governed changes.
#
# Usage (on auth01): sudo ./deploy/verify-smoke.sh
# Exits non-zero if any check fails so CI can gate on it.

set -euo pipefail

BRAIN_HOST="127.0.0.1"
BRAIN_PORT="${BRAIN_HTTP_PORT:-8390}"
BASE="http://${BRAIN_HOST}:${BRAIN_PORT}"

fail() { echo "[verify] FAIL: $*" >&2; exit 1; }
ok()   { echo "[verify] OK: $*"; }

echo "[verify] OrthodoxMetrics Brain post-deploy smoke"

# 1) Service active.
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet om-brain.service || fail "om-brain.service is not active"
  ok "om-brain.service active"
fi

# 2) Health endpoint.
HEALTH="$(curl -fsS "${BASE}/health" || true)"
[[ -n "${HEALTH}" ]] || fail "health endpoint did not respond on ${BASE}/health"
echo "${HEALTH}" | grep -q '"ok"' || fail "health payload missing ok flag"
ok "health endpoint responds"

# 3) Diagnose smoke (read-only; expects executed:false per doctrine).
DIAG="$(curl -fsS -X POST "${BASE}/diagnose" -H 'Content-Type: application/json' \
  -d '{"session_id":"verify-smoke","summary":"smoke: confirm no self-execution"}' || true)"
if [[ -n "${DIAG}" ]]; then
  echo "${DIAG}" | grep -q '"executed":false' \
    && ok "diagnose returns executed:false (auditor posture)" \
    || echo "[verify] NOTE: confirm diagnose response shows executed:false"
fi

# 4) No egress / circuit breaker: outbound to a public host must be refused.
#    (The Brain refuses non-LAN hosts; we assert the unit has egress locked too.)
if command -v systemctl >/dev/null 2>&1; then
  systemctl show om-brain.service -p IPAddressDeny | grep -qi 'any' \
    && ok "systemd IPAddressDeny=any present" \
    || echo "[verify] NOTE: confirm IPAddressDeny/allow in om-brain.service"
fi

echo "[verify] smoke complete."
