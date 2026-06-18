#!/usr/bin/env bash
# export-manus-ecosystem-bundle.sh
# Build a portable tarball for Manus deep dive: OM, OMAI, OMStudio, Workshop,
# Brain docs, governance package, redacted config templates.
#
# Usage:
#   om-brain/deploy/export-manus-ecosystem-bundle.sh
#   om-brain/deploy/export-manus-ecosystem-bundle.sh /backups/manus-exports/my-bundle
#
# Optional env overrides:
#   EXPORT_ROOT=/var/www/omai/exports   # default; local disk (~51G free on om-prod01)
#   EXPORT_ROOT=/backups/manus-exports  # NFS alternative (7T+) if local disk tight
#   OM_ROOT=/var/www/orthodoxmetrics/prod
#   OMAI_ROOT=/var/www/omai
#   OMSTUDIO_HOST=next@192.168.1.242
#   WORKSHOP_HOST=next@192.168.1.251
#   SKIP_REMOTE=1   # only bundle local repos
#   INCLUDE_MEDIA=1 # include public/images and server/storage (large)

set -euo pipefail

EXPORT_ROOT="${EXPORT_ROOT:-/var/www/omai/exports}"
OUT_DIR="${1:-${EXPORT_ROOT}/manus-ecosystem-$(date +%Y%m%d-%H%M%S)}"
OM_ROOT="${OM_ROOT:-/var/www/orthodoxmetrics/prod}"
OMAI_ROOT="${OMAI_ROOT:-/var/www/omai}"
OMSTUDIO_HOST="${OMSTUDIO_HOST:-next@192.168.1.242}"
WORKSHOP_HOST="${WORKSHOP_HOST:-next@192.168.1.251}"
REMOTE_OMSTUDIO="${REMOTE_OMSTUDIO:-/var/www/omstudio}"
REMOTE_WORKSHOP="${REMOTE_WORKSHOP:-/var/www/om-workshop}"

RSYNC_EXCLUDES=(
  --exclude 'node_modules'
  --exclude '.git'
  --exclude 'dist'
  --exclude 'build'
  --exclude '.next'
  --exclude 'coverage'
  --exclude '.turbo'
  --exclude '.cache'
  --exclude 'uploads'
  --exclude 'logs'
  --exclude '*.log'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '!*.env.example'
  --exclude '!**/.env.example'
  --exclude '.idea'
  --exclude '.vscode'
  --exclude '.cursor'
  --exclude '.credentials'
  --exclude 'server/.credentials'
  --exclude '*.tsbuildinfo'
  --exclude 'public-docs-library'
  --exclude 'misc-mirror'
  --exclude 'archive'
)

# Brain/code review does not need multi-GB assets; skip unless INCLUDE_MEDIA=1
if [[ "${INCLUDE_MEDIA:-0}" != "1" ]]; then
  RSYNC_EXCLUDES+=(
    --exclude 'server/storage'
    --exclude 'front-end/public/images'
    --exclude 'front-end/public/assets'
    --exclude 'public/images'
    --exclude 'public/assets'
    --exclude 'storage'
    --exclude '*.png'
    --exclude '*.jpg'
    --exclude '*.jpeg'
    --exclude '*.webp'
    --exclude '*.gif'
    --exclude '*.mp4'
    --exclude '*.zip'
    --exclude '*.tar.gz'
    --exclude '*.pdf'
  )
fi

mkdir -p "$OUT_DIR"/{repos,docs,config-templates,brain}

log() { printf '[manus-export] %s\n' "$*"; }

preflight() {
  if [[ "$OUT_DIR" == /tmp/* ]]; then
    log "WARN: output under /tmp (tmpfs quota). Prefer: EXPORT_ROOT=/backups/manus-exports"
  fi
  mkdir -p "$(dirname "$OUT_DIR")"
  local avail_kb
  avail_kb="$(df -k "$(dirname "$OUT_DIR")" | awk 'NR==2 {print $4}')"
  if [[ -n "$avail_kb" && "$avail_kb" -lt 3145728 ]]; then
    log "ERROR: less than 3 GB free on $(dirname "$OUT_DIR") — set EXPORT_ROOT=/backups/manus-exports or free disk"
    exit 1
  fi
  log "Writing to $OUT_DIR ($(df -h "$(dirname "$OUT_DIR")" | awk 'NR==2 {print $4 " free on " $1}'))"
}

git_meta() { :; }  # manifest uses python3

bundle_local_repo() {
  local src="$1" dest_name="$2"
  local dest="$OUT_DIR/repos/$dest_name"
  if [[ ! -d "$src" ]]; then
    log "SKIP missing: $src"
    return 0
  fi
  log "Bundling $dest_name from $src"
  mkdir -p "$dest"
  if git -C "$src" rev-parse HEAD &>/dev/null; then
    log "  → git archive HEAD (source only, no node_modules/dist)"
    git -C "$src" archive HEAD | tar -x -C "$dest"
  else
    log "  → rsync (not a git repo)"
    rsync -a "${RSYNC_EXCLUDES[@]}" "$src/" "$dest/"
  fi
}

bundle_remote_repo() {
  local host="$1" remote_path="$2" dest_name="$3"
  local dest="$OUT_DIR/repos/$dest_name"
  log "Remote bundle $host:$remote_path → $dest_name"
  mkdir -p "$dest"
  if ssh "$host" "git -C $(printf '%q' "$remote_path") rev-parse HEAD" &>/dev/null; then
    log "  → git archive over SSH"
    ssh "$host" "git -C $(printf '%q' "$remote_path") archive HEAD" | tar -x -C "$dest"
  else
    log "  → rsync fallback"
    rsync -a "${RSYNC_EXCLUDES[@]}" -e ssh "$host:$remote_path/" "$dest/" || {
      log "WARN: remote bundle failed for $dest_name ($host)"
    }
  fi
}

copy_brain_docs() {
  log "Copying Brain doc set"
  rsync -a \
    "$OMAI_ROOT/docs/om-brain/" \
    "$OUT_DIR/docs/om-brain/"
  rsync -a \
    "$OMAI_ROOT/om-brain/README.md" \
    "$OMAI_ROOT/om-brain/docs/" \
    "$OUT_DIR/brain/" 2>/dev/null || true
  rsync -a \
    "$OMAI_ROOT/packages/omstudio-brain-governance/" \
    "$OUT_DIR/brain/omstudio-brain-governance/" \
    --exclude 'node_modules' --exclude '.env'
  if [[ -f "$OMAI_ROOT/docs/OMStudio Governance Integration Contract and Implementation Plan (Fork A).md" ]]; then
    cp "$OMAI_ROOT/docs/OMStudio Governance Integration Contract and Implementation Plan (Fork A).md" \
      "$OUT_DIR/brain/"
  fi
}

copy_config_templates() {
  log "Copying redacted config templates"
  local files=(
    "$OMAI_ROOT/_runtime/server/config/platform-inventory.json"
    "$OMAI_ROOT/om-brain/deploy/om-brain.env.example"
    "$OMAI_ROOT/om-brain/deploy/om-brain-webhook.conf"
    "$OMAI_ROOT/packages/omstudio-brain-governance/.env.example"
    "$OM_ROOT/docs/03-om-omai-boundary.md"
    "$OM_ROOT/docs/07-platform-data-model.md"
    "$OM_ROOT/docs/18-orthodoxmetrics-business-workflows.md"
  )
  for f in "${files[@]}"; do
    [[ -f "$f" ]] && cp "$f" "$OUT_DIR/config-templates/" || true
  done
}

write_manifest() {
  local manifest="$OUT_DIR/MANIFEST.json"
  log "Writing $manifest"
  python3 - <<'PY' "$manifest" "$OM_ROOT" "$OMAI_ROOT" "$OUT_DIR"
import json, subprocess, sys, datetime
from datetime import timezone
from pathlib import Path

manifest, om_root, omai_root, out_dir = sys.argv[1:5]

def git_meta(path, name):
    p = Path(path)
    if not p.exists():
        return {name: {"path": str(path), "sha": "missing"}}
    try:
        sha = subprocess.check_output(["git", "-C", str(p), "rev-parse", "HEAD"], text=True).strip()
        branch = subprocess.check_output(["git", "-C", str(p), "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip()
        try:
            remote = subprocess.check_output(["git", "-C", str(p), "remote", "get-url", "origin"], text=True).strip()
        except subprocess.CalledProcessError:
            remote = "unknown"
        return {name: {"path": str(path), "sha": sha, "branch": branch, "remote": remote}}
    except subprocess.CalledProcessError:
        return {name: {"path": str(path), "sha": "not_a_git_repo"}}

repos = {}
repos.update(git_meta(om_root, "orthodoxmetrics-prod"))
repos.update(git_meta(omai_root, "omai"))
repos.update(git_meta(f"{out_dir}/repos/omstudio", "omstudio"))
repos.update(git_meta(f"{out_dir}/repos/om-workshop", "om-workshop"))
repos["_note"] = "om-brain lives inside omai repo at om-brain/"

doc = {
    "generated_at": datetime.datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "purpose": "Manus ecosystem deep dive — Brain connection and governance",
    "entry_doc": "docs/om-brain/00-manus-ecosystem-deep-dive.md",
    "reading_order": "docs/om-brain/README.md",
    "repos": repos,
    "hosts": {
        "om-primary": "192.168.1.239",
        "om-db": "192.168.1.241",
        "omstudio-primary": "192.168.1.242",
        "om-workshop-primary": "192.168.1.251",
        "auth01": "192.168.1.254",
    },
    "brain_endpoints": {
        "health": "http://127.0.0.1:8390/health",
        "diagnose": "POST http://127.0.0.1:8390/diagnose",
        "webhook_ingest": "POST http://192.168.1.254:8391/governance/approvals/:id/ingest-status",
        "omstudio_audit": "POST http://192.168.1.242/omstudio-embed/api/governance/brain/audit-events",
        "omstudio_approval": "POST http://192.168.1.242/omstudio-embed/api/governance/brain/approval-requests",
    },
    "oai_ingest_endpoints": [
        "GET /api/platform/events",
        "GET /api/platform/inventory?fresh=1",
        "GET /api/deploy-runs",
        "WS /ws/omai-logger",
    ],
    "secrets_not_included": [
        "BRAIN_OPS_JWT",
        "OMSTUDIO_SERVICE_TOKEN",
        "DB passwords",
        "Stripe keys",
        "Keycloak admin credentials",
    ],
}
Path(manifest).write_text(json.dumps(doc, indent=2) + "\n")
PY
}

write_readme() {
  cat > "$OUT_DIR/README.md" <<'EOF'
# Manus Ecosystem Bundle

Start here:

1. `docs/om-brain/00-manus-ecosystem-deep-dive.md` — Brain wiring map and Manus assignment
2. `docs/om-brain/README.md` — full doc index (01–18)
3. `MANIFEST.json` — commit SHAs and endpoint map
4. `repos/` — sanitized code trees (no node_modules, no .env secrets)
5. `brain/` — om-brain README, OMStudio contract, governance package

**auth01** is not a separate repo. Study `repos/omai/om-brain/` and `config-templates/om-brain.env.example`.

Deliverable: filled Brain Wiring Matrix (see deep-dive doc §5) + ranked implementation backlog.
EOF
}

# ─── main ───────────────────────────────────────────────────
preflight
log "Output: $OUT_DIR"
bundle_local_repo "$OM_ROOT" "orthodoxmetrics-prod"
bundle_local_repo "$OMAI_ROOT" "omai"

if [[ "${SKIP_REMOTE:-0}" != "1" ]]; then
  bundle_remote_repo "$OMSTUDIO_HOST" "$REMOTE_OMSTUDIO" "omstudio"
  bundle_remote_repo "$WORKSHOP_HOST" "$REMOTE_WORKSHOP" "om-workshop"
else
  log "SKIP_REMOTE=1 — omitting .242/.251 clones"
fi

copy_brain_docs
copy_config_templates
write_manifest
write_readme

TARBALL="${OUT_DIR}.tar.gz"
log "Creating $TARBALL"
tar -czf "$TARBALL" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"
log "Done: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
log "Remove partial dir if desired: rm -rf $(printf '%q' "$OUT_DIR")"
