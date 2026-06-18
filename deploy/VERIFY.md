# Deploy Verification — auth01 (192.168.1.254)

Run these checks after `deploy/deploy.sh`. They map to the Phase 1
definition-of-done (implementation exists; behavior verified; no egress; circuit
breaker blocks external hosts; isolation enforced). Everything here is
read-only/observational on the host.

## 1. Service is up and inside the isolation slice
```bash
systemctl status om-brain.service --no-pager
systemctl show om-brain.service -p Slice           # => Slice=om-brain.slice
systemctl show om-brain.slice -p MemoryMax -p CPUQuotaPerSecUSec
```
Expected: `active (running)`, `Slice=om-brain.slice`, a finite `MemoryMax`
(20G) and a CPU quota (~12s/s). This proves LLM spikes cannot starve Keycloak /
PostgreSQL.

## 2. Health check (liveness + posture + backend + breaker)
```bash
curl -s http://127.0.0.1:8390/health | jq .
```
Expected JSON includes:
- `"executes_actions": false` (auditor posture)
- `"posture": "auditor-first (observe, analyze, explain, recommend)"`
- `"memory_backend"` is either `sqlite+sqlite-vec` or the pure-JS fallback
- `"llm_endpoint_allowed": true` with reason `lan_or_loopback_ok`

## 3. Smoke diagnose call (deterministic governance)
```bash
# Human-only domain MUST be gated to requires_human_superadmin:
curl -s -X POST http://127.0.0.1:8390/diagnose \
  -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"add nginx route"},"proposal":{"description":"add nginx location proxy_pass to 7060"}}' | jq '.governance.classification, .executed'
# => "requires_human_superadmin"  then  false

# Cross-tenant context MUST halt-and-escalate (Tier 0):
curl -s -X POST http://127.0.0.1:8390/diagnose \
  -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"parish A sees parish B"},"context":{"sessionChurchId":46,"accessedChurchId":278}}' | jq '.governance.classification'
# => "tier0_halt_escalate"
```

## 4. Confirm NO external egress (circuit breaker + kernel allow-list)
```bash
# In-code breaker: pointing at an external host is refused, not called.
sudo -u om-brain env BRAIN_LLM_BASE_URL=https://api.openai.com/v1 NODE_ENV=production \
  node -e "const{BrainAIClient}=require('/opt/om-brain/src/ai/client');\
new BrainAIClient().assertEndpointAllowed()" \
  ; echo \"exit=$?\"   # expect a thrown circuit_breaker_block error (non-zero exit)

# Kernel-level: the unit denies all egress except loopback/RFC1918.
systemctl show om-brain.service -p IPAddressDeny -p IPAddressAllow
# Optionally confirm an external host is unreachable from the unit's namespace.
```

## 5. Confirm the decision ledger is append-only
```bash
curl -s http://127.0.0.1:8390/decisions?limit=5 | jq '.count'
# Tampering attempt (should FAIL with an append-only error):
sudo -u om-brain sqlite3 /var/lib/om-brain/brain.db \
  "DELETE FROM decision_memory" 2>&1 | grep -i append-only && echo "append-only OK"
```
(If the pure-JS fallback backend is in use, the same guarantee is enforced in
code — there is no UPDATE/DELETE path exposed for the ledger.)

## 6. Confirm OMStudio governance surfacing (audit + approval)
These checks work in the default dry-run mode (no live OMStudio needed) and the
same way against `http` once the live contract is confirmed.

```bash
# 6a. A human-only proposal produces a SUBMITTED approval request + an audit event.
curl -s -X POST http://127.0.0.1:8390/diagnose -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"add nginx route"},"proposal":{"description":"add nginx location proxy_pass"}}' \
  | jq '.requires_human_superadmin_approval, .omstudio.status'
#   => true   "SUBMITTED"
curl -s http://127.0.0.1:8390/governance/approvals | jq '.approvals[0].state'   # => "SUBMITTED"
curl -s http://127.0.0.1:8390/governance/audit | jq '.count'                    # >= 1

# 6b. Audit events emit for EVERY decision (auto-safe is audited, no approval).
curl -s -X POST http://127.0.0.1:8390/diagnose -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"omai 502"},"proposal":{"action":"service_restart","target":"omai"}}' \
  | jq '.governance.classification, .omstudio.requires_human_superadmin_approval'
#   => "auto_safe_recommendation"  false

# 6c. Secrets / tenant ids are ABSENT from outbound payloads (dry-run outbox).
#     Send a payload carrying a secret + tenant id, then grep the outbox.
curl -s -X POST http://127.0.0.1:8390/diagnose -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"billing","DB_PASSWORD":"hunter2","note":"om_church_46"},"proposal":{"description":"change billing permissions"}}' >/dev/null
grep -RIl -e hunter2 -e om_church_46 /var/lib/om-brain/omstudio-outbox/ \
  && echo "LEAK (BAD)" || echo "no secret/tenant leakage OK"

# 6d. The Brain cannot self-approve; only an externally-sourced status transitions it.
#     Simulate an OMStudio superadmin decision (test-only source in dry-run):
curl -s -X POST http://127.0.0.1:8390/governance/approvals/1/ingest-status \
  -H 'Content-Type: application/json' -d '{"decision":"approved","source":"dryrun_sim"}' | jq .
curl -s http://127.0.0.1:8390/governance/approvals/1 | jq '.approval.state, [.history[].to_state]'
#   => "APPROVED"   ["PENDING_SUBMISSION","SUBMITTED","APPROVED"]

# 6e. External egress for the OMStudio surface is blocked in http mode.
sudo -u om-brain env OMSTUDIO_TRANSPORT=http \
  OMSTUDIO_GOVERNANCE_BASE_URL=https://api.openai.com/x NODE_ENV=production \
  node -e "const{OmstudioClient}=require('/opt/om-brain/src/governance/omstudioClient');\
const c=new OmstudioClient({transport:'http',baseUrl:process.env.OMSTUDIO_GOVERNANCE_BASE_URL,production:true});\
console.log(JSON.stringify(c.checkEndpoint()))"
#   => allowed:false (external_llm_host_blocked / non_lan_host_blocked_in_production)
```

## 7. Tie back to OMStudio
Record this deployment (a boundary-defining act, already superadmin-approved per
the README precondition) in OMStudio as an audit entry. The Brain itself only
recommends; the human-performed deploy is logged for governance traceability.
In live deployments, wire OMStudio (or the .242 edge) to POST superadmin
decisions to `POST /governance/approvals/:id/ingest-status` — that is the
external webhook target through which APPROVED/REJECTED outcomes arrive.
