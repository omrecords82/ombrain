#!/usr/bin/env bash
# Install constrained om-dev resource checkers + Nagios SSH force-command key.
# Run on om-dev as root. Pair with ops key at /etc/nagios4/id_omdev_checks.
set -euo pipefail

LIB=/usr/local/lib/ombrain-nagios
AUTH_KEYS=/home/next/.ssh/authorized_keys
PUBKEY_SRC="${1:-}"

install -d -m 755 "$LIB"
install -m 755 "$(dirname "$0")/omdev-resource-check.sh" "$LIB/omdev-resource-check.sh"
install -m 755 "$(dirname "$0")/omdev-resource-check-ssh.sh" "$LIB/omdev-resource-check-ssh.sh"

if [[ -n "$PUBKEY_SRC" && -f "$PUBKEY_SRC" ]]; then
  PUB="$(cat "$PUBKEY_SRC")"
  LINE="command=\"$LIB/omdev-resource-check-ssh.sh\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty $PUB"
  mkdir -p /home/next/.ssh
  chmod 700 /home/next/.ssh
  touch "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
  chown next:next /home/next/.ssh "$AUTH_KEYS"
  if ! grep -qF "omdev-resource-check-ssh.sh" "$AUTH_KEYS" 2>/dev/null; then
    printf '%s\n' "$LINE" >>"$AUTH_KEYS"
    echo "authorized_keys: force-command entry added"
  else
    echo "authorized_keys: force-command entry already present"
  fi
else
  echo "NOTE: pass ops public key path as \$1 to install ForceCommand authorized_keys entry"
fi

echo "Installed checkers under $LIB"
"$LIB/omdev-resource-check.sh" root_disk || true
