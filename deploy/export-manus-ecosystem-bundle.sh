#!/usr/bin/env bash
# export-manus-ecosystem-bundle.sh
# Build a portable tarball for Manus deep dive: OM, OMAI, OMStudio, Workshop,
# Brain docs, governance package, redacted config templates.
#
# Usage:
#   ./scripts/export-manus-ecosystem-bundle.sh
#   ./scripts/export-manus-ecosystem-bundle.sh /tmp/my-bundle
#
# Optional env overrides:
#   OM_ROOT=/var/www/orthodoxmetrics/prod
#   OMAI_ROOT=/var/www/omai
#   OMSTUDIO_HOST=next@192.168.1.242
#   WORKSHOP_HOST=next@192.168.1.251
#   SKIP_REMOTE=1   # only bundle local repos

set -euo pipefail

OUT_DIR="${1:-/tmp/manus-ecosystem-$(date +%Y%m%d)}"
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
)

mkdir -p "$OUT_DIR"/{repos,docs,config-templates,brain}

log() { printf '[manus-export] %s\n' "$*"; }

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
  rsync -a "${RSYNC_EXCLUDES[@]}" "$src/" "$dest/"
}

bundle_remote_repo() {
  local host="$1" remote_path="$2" dest_name="$3"
  local dest="$OUT_DIR/repos/$dest_name"
  log "Remote rsync $host:$remote_path → $dest_name"
  mkdir -p "$dest"
  rsync -a "${RSYNC_EXCLUDES[@]}" -e ssh "$host:$remote_path/" "$dest/" || {
    log "WARN: remote rsync failed for $dest_name ($host)"
  }
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
    "generated_at": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
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
