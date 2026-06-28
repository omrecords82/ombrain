# OM Brain — Phase Tracker

**Host:** om-dev (`192.168.1.254`) — **not** auth01 (FreeIPA is `.252`)  
**Deploy path:** `/opt/om-brain` · env `/etc/om-brain/om-brain.env`  
**Last updated:** 2026-06-28 (host inventory tooling)

---

## Live state (corrected)

| Item | Status | Notes |
|------|--------|-------|
| Deploy on om-dev (.254) | ✅ Done | `om-brain.service` active, `/opt/om-brain`, slice isolated |
| Event adapter | ✅ On | Polls `192.168.1.239:7060/api/platform/events` every 30s |
| Inventory adapter | ✅ On | Polls `/api/platform/inventory` every 60s |
| Log adapter | ⏸ Disabled | `BRAIN_ENABLE_LOG_ADAPTER=false` — WS bridge upstream unstable (see Phase 1 note) |
| `OMSTUDIO_TRANSPORT` | ✅ `http` | Live Fork A to `.242/omstudio-embed` |
| `BRAIN_OPS_JWT` | ✅ Provisioned | `brain_ingest@orthodoxmetrics.com` via `deploy/provision-brain-ingest.sh` |
| `OMSTUDIO_SERVICE_TOKEN` | ✅ Matched | SHA256 hash identical on om-dev (.254) and `.242` (verified 2026-06-27) |
| Governance E2E | ✅ Verified | diagnose → audit → approve → webhook → APPROVED (2026-06-27) |
| Host inventory snapshot | ✅ On main | `om-brain/inventory/hosts.json` + `collect-hosts.js` → `HOST-SNAPSHOT.md` |

### Host references (do not confuse)

| Wrong (legacy docs) | Correct |
|---------------------|---------|
| Brain / Keycloak on auth01 `.254` | Brain on **om-dev `.254`**; Keycloak on **auth1/keycloak `.253`** (Docker) |
| auth01 = Brain host | **auth01 = FreeIPA `.252`** (+ `.37`) |
| MariaDB on `.77` (production) | Central OM DB on **`.241`**; `.77` is replica-sync target only |
| OMStudio governance on `.241` | Fork A on **`.242`** (`omstudio_db`, nginx `/omstudio-embed`) |
| omai-ops undocumented | **ops `.40`** → `/srv/omai-ops` |

---

## Phase 1 — Governance & ingest verification

- [x] Token hash match om-dev (.254) ↔ OMStudio `.242`
- [x] POST `audit-events` smoke (201, not 401)
- [x] Human-only `/diagnose` → SUBMITTED approval + audit row in MariaDB
- [x] Superadmin decision → webhook `:8391` → Brain `ingest-status` → APPROVED
- [x] Disable log adapter until WS upstream bridge stable
- [x] Add `om-brain` to platform inventory (`om-dev`)
- [ ] Re-enable log adapter after OMAI `:7060` → OM `:3001` logger WS bridge fixed
- [x] Manus/build team: Phase 2 scope sign-off (memory layers, calendar, church finder) — SIGNED OFF 2026-06-28 by user (Google Places deferred)

See `docs/om-brain/94-phase1-verification-note.md` for smoke-test evidence (no secrets).

---

## Phase 2+ (not started)

- [ ] Memory layer expansion (work memory, RAG tuning)
- [ ] NATS / satellite transport decision (`docs/om-brain/19-brain-master-satellite-transport-options.md`)
- [ ] Workshop read-only hooks (`.251`)
- [ ] Church finder / Google Places (deferred — LAN-only circuit breaker conflict)

---

## Ops quick reference

```bash
# Health (on om-dev .254)
curl -s http://127.0.0.1:8390/health | jq .

# VERIFY.md full checklist
om-brain/deploy/VERIFY.md

# Re-provision ingest JWT (on .239)
set -a && source /var/www/omai/.env.omai && set +a
sudo -E om-brain/deploy/provision-brain-ingest.sh --update-om-dev

# Refresh host snapshot (commit result)
cd om-brain && node scripts/collect-hosts.js
```
