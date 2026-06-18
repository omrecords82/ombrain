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

## 6. Tie back to OMStudio
Record this deployment (a boundary-defining act, already superadmin-approved per
the README precondition) in OMStudio as an audit entry. The Brain itself only
recommends; the human-performed deploy is logged for governance traceability.
