#!/usr/bin/env bash
# Forced-command SSH wrapper for Nagios → om-dev resource checks.
# authorized_keys must set: command=".../omdev-resource-check-ssh.sh",restrict
# SSH_ORIGINAL_COMMAND must be exactly one allowlisted check name.
set -euo pipefail

CHECKER="${OMDEV_RESOURCE_CHECKER:-/usr/local/lib/ombrain-nagios/omdev-resource-check.sh}"
RAW="${SSH_ORIGINAL_COMMAND:-}"

# Accept either bare check name or "check <name>"
CHECK="$(printf '%s' "$RAW" | awk '{print $NF}')"

if [[ -z "$CHECK" ]]; then
  echo "UNKNOWN - missing allowlisted check name"
  exit 3
fi
if [[ ! "$CHECK" =~ ^[a-z0-9_]+$ ]]; then
  echo "UNKNOWN - invalid check token"
  exit 3
fi

case "$CHECK" in
  root_disk|inodes|memory|swap|load|om_brain_service|om_brain_console_service|nginx|cert_expiry|plans_mount)
    exec "$CHECKER" "$CHECK"
    ;;
  *)
    echo "UNKNOWN - check '$CHECK' is not allowlisted"
    exit 3
    ;;
esac
