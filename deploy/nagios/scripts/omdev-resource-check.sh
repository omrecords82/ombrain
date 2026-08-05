#!/usr/bin/env bash
# Constrained host resource checks for om-dev (allowlisted check names only).
# Invoked from Nagios on ops via a fixed SSH command line — no remote shell
# interpolation of arbitrary arguments beyond the allowlisted check name.
#
# Usage: omdev-resource-check.sh <check_name>
# Exit: 0 OK, 1 WARNING, 2 CRITICAL, 3 UNKNOWN (Nagios plugin codes)
set -euo pipefail

CHECK="${1:-}"
WARN_DISK="${OMDEV_DISK_WARN:-80}"
CRIT_DISK="${OMDEV_DISK_CRIT:-90}"
WARN_INODE="${OMDEV_INODE_WARN:-80}"
CRIT_INODE="${OMDEV_INODE_CRIT:-90}"
WARN_MEM="${OMDEV_MEM_WARN:-85}"
CRIT_MEM="${OMDEV_MEM_CRIT:-95}"
WARN_SWAP="${OMDEV_SWAP_WARN:-50}"
CRIT_SWAP="${OMDEV_SWAP_CRIT:-80}"
WARN_LOAD="${OMDEV_LOAD_WARN:-}"
CRIT_LOAD="${OMDEV_LOAD_CRIT:-}"
PLANS_MOUNT="${OMDEV_PLANS_MOUNT:-/mnt/fileserver01/plans}"
PLANS_EXPECT_SRC="${OMDEV_PLANS_EXPECT_SRC:-//192.168.1.232/plans}"
PLANS_EXPECT_FSTYPE="${OMDEV_PLANS_EXPECT_FSTYPE:-cifs}"
CERT_HOST="${OMDEV_CERT_HOST:-omdev.om.internal}"
CERT_PORT="${OMDEV_CERT_PORT:-443}"
CERT_CONNECT="${OMDEV_CERT_CONNECT:-127.0.0.1}"
CERT_WARN_DAYS="${OMDEV_CERT_WARN_DAYS:-21}"
CERT_CRIT_DAYS="${OMDEV_CERT_CRIT_DAYS:-7}"

ok() { echo "OK - $*"; exit 0; }
warn() { echo "WARNING - $*"; exit 1; }
crit() { echo "CRITICAL - $*"; exit 2; }
unknown() { echo "UNKNOWN - $*"; exit 3; }

pct_used_from_df() {
  # $1 = df -P output line for target
  awk 'NR==2 { gsub(/%/,"",$5); print $5 }' <<<"$1"
}

check_root_disk() {
  local out pct
  out="$(df -P /)"
  pct="$(pct_used_from_df "$out")"
  local line
  line="$(awk 'NR==2 {printf "%s %s used of %s (%s avail)", $6,$3,$2,$4}' <<<"$out")"
  if [[ "$pct" -ge "$CRIT_DISK" ]]; then crit "root filesystem ${pct}% used |$line;root_used_pct=${pct}"
  elif [[ "$pct" -ge "$WARN_DISK" ]]; then warn "root filesystem ${pct}% used |$line;root_used_pct=${pct}"
  else ok "root filesystem ${pct}% used |root_used_pct=${pct}"
  fi
}

check_inodes() {
  local out pct
  out="$(df -Pi /)"
  pct="$(pct_used_from_df "$out")"
  if [[ "$pct" -ge "$CRIT_INODE" ]]; then crit "root inodes ${pct}% used |inode_used_pct=${pct}"
  elif [[ "$pct" -ge "$WARN_INODE" ]]; then warn "root inodes ${pct}% used |inode_used_pct=${pct}"
  else ok "root inodes ${pct}% used |inode_used_pct=${pct}"
  fi
}

check_memory() {
  # Prefer MemAvailable
  local total avail used_pct
  total="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  avail="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  if [[ -z "$total" || -z "$avail" || "$total" -eq 0 ]]; then unknown "cannot read /proc/meminfo"; fi
  used_pct=$(( (100 * (total - avail)) / total ))
  if [[ "$used_pct" -ge "$CRIT_MEM" ]]; then crit "memory ${used_pct}% used |mem_used_pct=${used_pct}"
  elif [[ "$used_pct" -ge "$WARN_MEM" ]]; then warn "memory ${used_pct}% used |mem_used_pct=${used_pct}"
  else ok "memory ${used_pct}% used |mem_used_pct=${used_pct}"
  fi
}

check_swap() {
  local total free used_pct
  total="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  free="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  if [[ -z "$total" ]]; then unknown "cannot read swap"; fi
  if [[ "$total" -eq 0 ]]; then ok "swap not configured |swap_used_pct=0"; fi
  used_pct=$(( (100 * (total - free)) / total ))
  if [[ "$used_pct" -ge "$CRIT_SWAP" ]]; then crit "swap ${used_pct}% used |swap_used_pct=${used_pct}"
  elif [[ "$used_pct" -ge "$WARN_SWAP" ]]; then warn "swap ${used_pct}% used |swap_used_pct=${used_pct}"
  else ok "swap ${used_pct}% used |swap_used_pct=${used_pct}"
  fi
}

check_load() {
  local cores load1 w c
  cores="$(nproc)"
  load1="$(awk '{print $1}' /proc/loadavg)"
  w="${WARN_LOAD:-$(awk -v c="$cores" 'BEGIN{printf "%.2f", c*1.5}')}"
  c="${CRIT_LOAD:-$(awk -v c="$cores" 'BEGIN{printf "%.2f", c*2.5}')}"
  awk -v l="$load1" -v w="$w" -v c="$c" -v cores="$cores" 'BEGIN{
    if (l+0 >= c+0) { printf "CRITICAL - load1=%s cores=%s |load1=%s\n", l, cores, l; exit 2 }
    if (l+0 >= w+0) { printf "WARNING - load1=%s cores=%s |load1=%s\n", l, cores, l; exit 1 }
    printf "OK - load1=%s cores=%s |load1=%s\n", l, cores, l; exit 0
  }'
}

check_unit() {
  local unit="$1"
  if ! systemctl is-enabled --quiet "$unit" 2>/dev/null && ! systemctl cat "$unit" >/dev/null 2>&1; then
    unknown "unit $unit not found"
  fi
  local state
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then ok "$unit is active |${unit//./_}_active=1"
  else crit "$unit is $state |${unit//./_}_active=0"
  fi
}

check_nginx() { check_unit nginx.service; }
check_om_brain() { check_unit om-brain.service; }
check_om_brain_console() { check_unit om-brain-console.service; }

check_cert() {
  # Local TLS probe — days until expiry
  local end end_epoch now days
  end="$(echo | openssl s_client -servername "$CERT_HOST" -connect "${CERT_CONNECT}:${CERT_PORT}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [[ -z "$end" ]]; then unknown "cannot read certificate on ${CERT_CONNECT}:${CERT_PORT} (sni=$CERT_HOST)"; fi
  end_epoch="$(date -d "$end" +%s)"
  now="$(date +%s)"
  days=$(( (end_epoch - now) / 86400 ))
  if [[ "$days" -le "$CERT_CRIT_DAYS" ]]; then crit "cert expires in ${days}d ($end) |cert_days=${days}"
  elif [[ "$days" -le "$CERT_WARN_DAYS" ]]; then warn "cert expires in ${days}d ($end) |cert_days=${days}"
  else ok "cert expires in ${days}d ($end) |cert_days=${days}"
  fi
}

check_plans_mount() {
  # Read-only client-side CIFS dependency check — never writes.
  if ! findmnt -n "$PLANS_MOUNT" >/dev/null 2>&1; then
    crit "plans mount missing at $PLANS_MOUNT"
  fi
  local fstype src
  fstype="$(findmnt -n -o FSTYPE "$PLANS_MOUNT" 2>/dev/null || true)"
  src="$(findmnt -n -o SOURCE "$PLANS_MOUNT" 2>/dev/null || true)"
  if [[ "$fstype" != "$PLANS_EXPECT_FSTYPE" ]]; then
    crit "plans fstype=$fstype expected=$PLANS_EXPECT_FSTYPE"
  fi
  if [[ "$src" != "$PLANS_EXPECT_SRC" ]]; then
    crit "plans source=$src expected=$PLANS_EXPECT_SRC"
  fi
  # Responsiveness + readability (no write)
  if ! timeout 5 ls "$PLANS_MOUNT" >/dev/null 2>&1; then
    crit "plans mount unresponsive or unreadable"
  fi
  if [[ ! -d "$PLANS_MOUNT" ]]; then
    crit "plans directory missing"
  fi
  local pct
  pct="$(df -P "$PLANS_MOUNT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  if [[ -z "$pct" ]]; then unknown "cannot measure plans free space"; fi
  if [[ "$pct" -ge 95 ]]; then crit "plans ${pct}% used |plans_used_pct=${pct};fstype=${fstype}"
  elif [[ "$pct" -ge 85 ]]; then warn "plans ${pct}% used |plans_used_pct=${pct};fstype=${fstype}"
  else ok "plans mounted src=$src fstype=$fstype ${pct}% used |plans_used_pct=${pct}"
  fi
}

case "$CHECK" in
  root_disk) check_root_disk ;;
  inodes) check_inodes ;;
  memory) check_memory ;;
  swap) check_swap ;;
  load) check_load ;;
  om_brain_service) check_om_brain ;;
  om_brain_console_service) check_om_brain_console ;;
  nginx) check_nginx ;;
  cert_expiry) check_cert ;;
  plans_mount) check_plans_mount ;;
  '') unknown "missing check name (allowlisted only)" ;;
  *) unknown "check '$CHECK' is not allowlisted" ;;
esac
