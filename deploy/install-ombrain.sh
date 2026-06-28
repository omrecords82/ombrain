#!/usr/bin/env bash
#
# install-ombrain.sh — install the `ombrain` CLI system-wide on any server.
#
# The `ombrain` command is a thin, zero-dependency HTTP client (bin/ombrain.js)
# that talks to a running om-brain service. It works on ANY host that can reach
# the Brain — the host does NOT need the full source tree, only Node.js and
# the single ombrain.js file.
#
# The installer writes a small launcher to <prefix>/ombrain that invokes the
# resolved node interpreter explicitly, so the command works even when the
# caller's PATH does not include node (e.g. nvm installs under sudo).
#
# Two install modes (auto-detected):
#
#   1. ON THE BRAIN HOST (source present, e.g. /opt/om-brain):
#        sudo bash deploy/install-ombrain.sh
#      -> launcher runs <repo>/om-brain/bin/ombrain.js (stays current with deploys)
#
#   2. ON A REMOTE HOST (no source): copy bin/ombrain.js over first, then:
#        sudo bash install-ombrain.sh --standalone /path/to/ombrain.js
#      -> installs a copy of ombrain.js next to the launcher
#
# Options:
#   --prefix <dir>          Install dir for the launcher (default: /usr/local/bin)
#   --standalone <f>        Install a copy of the given ombrain.js (remote hosts)
#   --node <path>           Explicit path to the node binary (skip auto-detect)
#   --url <url>             Bake a default OMBRAIN_URL into /etc/om-brain/ombrain.conf
#   --register-master <h>   Seed the server registry with master host <h>
#   --register-backup <h>   Seed/append a backup host <h> (repeatable)
#   --ports <spec>          Port pool for the seeded host(s) (default 60000-62000)
#   --uninstall             Remove the installed command
#   -h, --help              Show help
#
# The registry is written to /etc/om-brain/ombrain.servers.json. ombrain reads
# master -> backups and load-balances each request across the host's port pool.
#
set -euo pipefail

PREFIX="/usr/local/bin"
STANDALONE=""
NODE_BIN=""
DEFAULT_URL=""
REGISTER_MASTER=""
REGISTER_BACKUPS=()
PORTS_SPEC="60000-62000"
UNINSTALL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CLI="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)/bin/ombrain.js"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --standalone) STANDALONE="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --url) DEFAULT_URL="$2"; shift 2 ;;
    --register-master) REGISTER_MASTER="$2"; shift 2 ;;
    --register-backup) REGISTER_BACKUPS+=("$2"); shift 2 ;;
    --ports) PORTS_SPEC="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

TARGET="$PREFIX/ombrain"
LIBDIR="/usr/local/lib/om-brain"   # where a standalone copy of ombrain.js lives

if [[ "$UNINSTALL" -eq 1 ]]; then
  rm -f "$TARGET"
  rm -f "$LIBDIR/ombrain.js" 2>/dev/null || true
  echo "removed $TARGET"
  exit 0
fi

# --- Resolve a usable node interpreter -------------------------------------
# sudo often sanitizes PATH (nvm installs vanish), so search common locations
# and fall back to the invoking user's node.
detect_node() {
  if [[ -n "$NODE_BIN" ]]; then echo "$NODE_BIN"; return; fi
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  # Common system + nvm locations
  for p in /usr/bin/node /usr/local/bin/node /opt/node/bin/node /snap/bin/node; do
    [[ -x "$p" ]] && { echo "$p"; return; }
  done
  # nvm of the sudo-invoking user
  local home_user
  home_user="$(eval echo "~${SUDO_USER:-$USER}")"
  if [[ -d "$home_user/.nvm/versions/node" ]]; then
    local latest
    latest="$(ls -1 "$home_user/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [[ -n "$latest" && -x "$home_user/.nvm/versions/node/$latest/bin/node" ]] && {
      echo "$home_user/.nvm/versions/node/$latest/bin/node"; return; }
  fi
  echo ""
}

NODE="$(detect_node)"
if [[ -z "$NODE" ]]; then
  echo "error: could not find a node interpreter." >&2
  echo "       install Node.js >= 18, or pass --node /path/to/node" >&2
  exit 1
fi
echo "using node: $NODE"

mkdir -p "$PREFIX"

# --- Resolve the CLI file to run -------------------------------------------
if [[ -n "$STANDALONE" ]]; then
  if [[ ! -f "$STANDALONE" ]]; then
    echo "error: --standalone file not found: $STANDALONE" >&2
    exit 1
  fi
  mkdir -p "$LIBDIR"
  install -m 0755 "$STANDALONE" "$LIBDIR/ombrain.js"
  CLI_PATH="$LIBDIR/ombrain.js"
  echo "installed standalone copy -> $CLI_PATH"
else
  if [[ ! -f "$SOURCE_CLI" ]]; then
    echo "error: cannot find bin/ombrain.js at $SOURCE_CLI" >&2
    echo "       run from the repo, or use: --standalone /path/to/ombrain.js" >&2
    exit 1
  fi
  chmod +x "$SOURCE_CLI" 2>/dev/null || true
  CLI_PATH="$SOURCE_CLI"
  echo "using source CLI -> $CLI_PATH"
fi

# --- Write the launcher ----------------------------------------------------
# A tiny shell wrapper that calls the resolved node on the resolved CLI,
# sourcing an optional /etc/om-brain/ombrain.conf for a default OMBRAIN_URL.
cat > "$TARGET" <<EOF
#!/usr/bin/env bash
# ombrain launcher (generated by install-ombrain.sh)
if [[ -f /etc/om-brain/ombrain.conf ]]; then
  set -a; . /etc/om-brain/ombrain.conf; set +a
fi
exec "$NODE" "$CLI_PATH" "\$@"
EOF
chmod 0755 "$TARGET"
echo "wrote launcher -> $TARGET"

# --- Optional: bake a default base URL -------------------------------------
if [[ -n "$DEFAULT_URL" ]]; then
  mkdir -p /etc/om-brain
  echo "OMBRAIN_URL=$DEFAULT_URL" > /etc/om-brain/ombrain.conf
  echo "wrote default URL -> /etc/om-brain/ombrain.conf"
fi

# --- Optional: seed the server registry (master / backups + port pool) -----
if [[ -n "$REGISTER_MASTER" ]]; then
  mkdir -p /etc/om-brain
  REG=/etc/om-brain/ombrain.servers.json
  {
    echo '{'
    echo '  "version": 1,'
    echo '  "rr": 0,'
    echo '  "servers": ['
    printf '    { "name": "master", "scheme": "http", "host": "%s", "ports": "%s", "role": "master", "priority": 0 }' "$REGISTER_MASTER" "$PORTS_SPEC"
    i=1
    for b in "${REGISTER_BACKUPS[@]:-}"; do
      [[ -z "$b" ]] && continue
      printf ',\n    { "name": "backup%d", "scheme": "http", "host": "%s", "ports": "%s", "role": "backup", "priority": %d }' "$i" "$b" "$PORTS_SPEC" "$((i*10))"
      i=$((i+1))
    done
    echo ''
    echo '  ]'
    echo '}'
  } > "$REG"
  echo "wrote server registry -> $REG (master=$REGISTER_MASTER, ports=$PORTS_SPEC, backups=${#REGISTER_BACKUPS[@]})"
fi

# --- Verify ----------------------------------------------------------------
echo
echo "verifying..."
if "$TARGET" --version >/dev/null 2>&1; then
  echo "  $("$TARGET" --version)  OK"
else
  echo "  warning: '$TARGET --version' did not run cleanly." >&2
fi

echo
echo "done. Try:"
echo "  ombrain --help"
echo "  ombrain health                 # uses \$OMBRAIN_URL or http://127.0.0.1:8390"
echo "  ombrain --url http://<brain-host>:8390 health"
