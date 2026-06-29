#!/usr/bin/env bash
# fleet.find_env_files@v1 — locate .env files (paths only; never read contents).
set -euo pipefail

HOSTNAME="${HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"
paths=()
errors=()

if [[ -n "${FLEET_SCAN_ROOTS:-}" ]]; then
  IFS=':' read -ra search_roots <<< "$FLEET_SCAN_ROOTS"
else
  search_roots=("/var/www" "/opt" "/etc/omai")
fi
maxdepth=6

append_path() {
  local p="$1"
  [[ -z "$p" ]] && return
  paths+=("$p")
}

for root in "${search_roots[@]}"; do
  if [[ ! -d "$root" ]]; then
    continue
  fi
  mapfile -d '' found < <(
    find "$root" -maxdepth "$maxdepth" \
      \( \
        -path '*/node_modules/*' -o \
        -path '*/vendor/*' -o \
        -path '*/.git/*' -o \
        -path '*/cache/*' -o \
        -path '*/.cache/*' -o \
        -path '*/backups/*' -o \
        -path '*/backup/*' -o \
        -path '*/__pycache__/*' \
      \) -prune \
      -o \( -name '.env' -o -name '.env.*' \) -type f -print0 2>/dev/null || true
  )
  for f in "${found[@]}"; do
    append_path "$f"
  done
done

# Stable sort for deterministic output
if [[ ${#paths[@]} -gt 0 ]]; then
  mapfile -t paths < <(printf '%s\n' "${paths[@]}" | sort -u)
fi

count=${#paths[@]}

printf '%s\n' "${paths[@]}" | node -e "
const fs = require('fs');
const paths = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
const out = {
  hostname: process.env.HOSTNAME || 'unknown',
  paths,
  count: paths.length,
  errors: [],
};
process.stdout.write(JSON.stringify(out));
"
