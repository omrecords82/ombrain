#!/usr/bin/env bash
#
# teardown.sh — rollback / remove the OrthodoxMetrics Brain from auth01.
#
# Stops and disables the service and removes installed units. By default the
# memory state (/var/lib/om-brain) and env file are PRESERVED for audit; pass
# --purge to also remove them (a data-deletion act — confirm with superadmin and
# log to OMStudio).
#
# Usage:
#   sudo ./deploy/teardown.sh           # remove service, keep state + env
#   sudo ./deploy/teardown.sh --purge   # also delete state + env (human-approved)

set -euo pipefail

PURGE="no"
[[ "${1:-}" == "--purge" ]] && PURGE="yes"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[teardown] ERROR: must run as root (sudo)." >&2
  exit 1
fi

echo "[teardown] stopping and disabling om-brain.service"
systemctl stop om-brain.service 2>/dev/null || true
systemctl disable om-brain.service 2>/dev/null || true

echo "[teardown] removing systemd unit + slice"
rm -f /etc/systemd/system/om-brain.service
rm -f /etc/systemd/system/om-brain.slice
systemctl daemon-reload

echo "[teardown] removing application code at /opt/om-brain"
rm -rf /opt/om-brain

if [[ "${PURGE}" == "yes" ]]; then
  echo "[teardown] --purge: removing state and env (data-deletion; ensure superadmin sign-off + OMStudio audit)"
  rm -rf /var/lib/om-brain
  rm -rf /etc/om-brain
  # The service user is left in place; removing accounts is a separate human act.
else
  echo "[teardown] preserving /var/lib/om-brain and /etc/om-brain for audit"
fi

echo "[teardown] done."
