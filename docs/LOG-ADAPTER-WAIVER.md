# P1-1: Log Adapter Assessment — Formal Waiver

**Date:** 2026-06-27  
**Status:** CODE COMPLETE — operational verification required  
**Prepared by:** Manus relay

---

## Assessment

The rapid connect/close loop fix was already implemented in `src/adapters/logAdapter.js` prior to this P1 round. The following changes are confirmed present in the deployed source:

| Fix | Location | Status |
|-----|----------|--------|
| Destroy prior socket before reconnecting | `logAdapter.js` lines 58–90 | **Present** |
| ±25% jitter on exponential backoff | `logAdapter.js` lines 95–115 | **Present** |
| Self-disable after `BRAIN_LOG_WS_MAX_RETRIES` | `logAdapter.js` lines 143–152 | **Present** |
| Respects `BRAIN_ENABLE_LOG_ADAPTER` env flag | `logAdapter.js` lines 143–152 | **Present** |

No code changes are required for P1-1.

---

## Remaining operational steps (run on .254)

These are verification and configuration steps, not code changes.

### Step 1 — Confirm current adapter state

```bash
# Check whether the adapter is currently enabled
grep BRAIN_ENABLE_LOG_ADAPTER /etc/om-brain/om-brain.env
# Expected: BRAIN_ENABLE_LOG_ADAPTER=false  (intentionally disabled per handoff)

# Check journal for self-disable events
journalctl -u om-brain --since "1 hour ago" | grep -E "log_adapter|ws_connect|ws_close|max_retries"
```

### Step 2 — Decision: re-enable or leave disabled

The adapter is intentionally disabled (`BRAIN_ENABLE_LOG_ADAPTER=false`) per the handoff note. Before re-enabling, confirm:

1. The WebSocket endpoint on OMAI (`:7060/api/logs/stream` or equivalent) is accepting connections
2. The `BRAIN_OPS_JWT` token is valid and accepted by the OMAI log stream endpoint
3. The log stream endpoint is rate-limited or backpressure-aware

If all three are confirmed, re-enable:

```bash
# Edit the env file
sed -i 's/BRAIN_ENABLE_LOG_ADAPTER=false/BRAIN_ENABLE_LOG_ADAPTER=true/' /etc/om-brain/om-brain.env
systemctl restart om-brain

# Watch for rapid reconnects (should NOT see more than 1 connect per 30s after backoff)
journalctl -u om-brain -f | grep -E "log_ws|ws_connect|ws_error"
```

### Step 3 — JWT rotation (separate governed task)

The `JWT_ACCESS_SECRET` rotation is flagged as a governed ops task in TODO §2c. It is not part of this code package. Schedule it through the standard OMStudio approval workflow.

---

## Waiver decision

**P1-1 is waived as a code deliverable.** The implementation is complete. The remaining items are:

- `[ ]` Operational: confirm OMAI log stream endpoint is healthy before re-enabling
- `[ ]` Operational: re-enable `BRAIN_ENABLE_LOG_ADAPTER=true` after endpoint confirmation
- `[ ]` Governed: schedule `JWT_ACCESS_SECRET` rotation via OMStudio

These items are tracked in TODO §2c and do not require a Manus code package.
