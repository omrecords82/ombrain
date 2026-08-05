#!/usr/bin/env bash
# OMBrain-safe Nagios notification sink — append-only receipt log with structured fields.
# Positional contract (enable_environment_macros may be 0):
#   service: service <type> <host> <service> <state> <output> [author] [comment] [contact] [event_ts]
#   host:    host    <type> <host> <state> <output> [author] [comment] [contact] [event_ts]
set -euo pipefail

LOG="${NAGIOS_RECEIPT_LOG:-/var/log/nagios4/notification-receipt.log}"
umask 027
mkdir -p "$(dirname "$LOG")"

SOURCE="${1:-}"
TYPE="${2:-}"

if [[ "$SOURCE" != "service" && "$SOURCE" != "host" ]]; then
  # Fail safe: still record raw, but mark malformed in structured fields.
  {
    echo "----"
    echo "ts_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "command_source="
    echo "notification_type="
    echo "host="
    echo "service="
    echo "state="
    echo "author="
    echo "comment="
    echo "contact="
    echo "event_timestamp="
    echo "test_marker="
    echo "parse_ok=0"
    echo "parse_error=invalid_command_source"
    echo "raw=$*"
  } >>"$LOG"
  exit 0
fi

if [[ "$SOURCE" == "service" ]]; then
  HOST="${3:-}"
  SERVICE="${4:-}"
  STATE="${5:-}"
  OUTPUT="${6:-}"
  AUTHOR="${7:-}"
  COMMENT="${8:-}"
  CONTACT="${9:-}"
  EVENT_TS="${10:-}"
else
  HOST="${3:-}"
  SERVICE=""
  STATE="${4:-}"
  OUTPUT="${5:-}"
  AUTHOR="${6:-}"
  COMMENT="${7:-}"
  CONTACT="${8:-}"
  EVENT_TS="${9:-}"
fi

TEST_MARKER=""
for cand in "$COMMENT" "$OUTPUT" "$AUTHOR"; do
  if [[ "$cand" =~ (OMBRAIN-[A-Z0-9:_-]+) ]]; then
    TEST_MARKER="${BASH_REMATCH[1]}"
    break
  fi
done

PARSE_OK=1
PARSE_ERROR=""
if [[ -z "$TYPE" ]]; then
  PARSE_OK=0
  PARSE_ERROR="missing_notification_type"
fi
if [[ -z "$HOST" ]]; then
  PARSE_OK=0
  PARSE_ERROR="${PARSE_ERROR:+$PARSE_ERROR;}missing_host"
fi

{
  echo "----"
  echo "ts_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "command_source=$SOURCE"
  echo "notification_type=$TYPE"
  echo "type=$TYPE"
  echo "host=$HOST"
  echo "service=$SERVICE"
  echo "state=$STATE"
  echo "hoststate=$([[ "$SOURCE" == host ]] && echo "$STATE" || true)"
  echo "servicestate=$([[ "$SOURCE" == service ]] && echo "$STATE" || true)"
  echo "output=$OUTPUT"
  echo "author=$AUTHOR"
  echo "comment=$COMMENT"
  echo "contact=$CONTACT"
  echo "event_timestamp=$EVENT_TS"
  echo "test_marker=$TEST_MARKER"
  echo "parse_ok=$PARSE_OK"
  echo "parse_error=$PARSE_ERROR"
  echo "raw=$*"
} >>"$LOG"
exit 0
