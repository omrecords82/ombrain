#!/usr/bin/env bash
# Authenticated read-only Plans SMB share check for fileserver01.
# Credentials: /etc/nagios4/smb-plans.cred (KEY=value; never commit).
# Keys: SMB_USER SMB_PASSWORD SMB_DOMAIN SMB_SHARE SMB_HOST SMB_ADDRESS
set -euo pipefail

CRED_FILE="${SMB_PLANS_CRED_FILE:-/etc/nagios4/smb-plans.cred}"
PLUGIN="${CHECK_DISK_SMB:-/usr/lib/nagios/plugins/check_disk_smb}"

if [[ ! -r "$CRED_FILE" ]]; then
  echo "UNKNOWN - SMB credential file not readable"
  exit 3
fi

# shellcheck disable=SC1090
source "$CRED_FILE"

HOST="${SMB_HOST:-fileserver01}"
ADDR="${SMB_ADDRESS:-192.168.1.232}"
SHARE="${SMB_SHARE:-plans}"
USER="${SMB_USER:?SMB_USER required}"
PASS="${SMB_PASSWORD:?SMB_PASSWORD required}"
DOMAIN="${SMB_DOMAIN:-OM.INTERNAL}"
WARN="${SMB_WARN:-85%}"
CRIT="${SMB_CRIT:-95%}"

# Do not echo credentials. Plugin argv may be visible briefly in process list;
# file-based creds + 640 root:nagios is the approved storage method.
exec "$PLUGIN" -H "$HOST" -a "$ADDR" -s "$SHARE" -W "$DOMAIN" -u "$USER" -p "$PASS" -w "$WARN" -c "$CRIT"
