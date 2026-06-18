# OMStudio Governance Integration: Contract & Implementation Plan (Fork A)

This document specifies the exact contract, architecture decisions, and server-side implementation plan for integrating the deployed OrthodoxMetrics Brain (auth01) with the OMStudio governance surface.

Every claim regarding the Brain's behavior, payload shapes, and constraints is grounded in the **actual, currently deployed Brain code** (`Init2` package).

---

## 0. Executive Summary & Architecture Decision

**Decision:** We are proceeding with **Architecture Fork (A)** — delivering an OMStudio-side implementation that matches the existing assumed contract in `omstudioClient.js`, rather than overloading Workshop's existing `/approvals/*` routes.

**Justification for Fork A:**
- **Separation of Concerns:** The Brain operates under a strict Phase 1 auditor posture. Its outputs are system-level governance events, distinct from Workshop's user-facing content approvals.
- **Distinct Audit Semantics:** The Brain requires an append-only ledger mirroring its internal `decision_memory` for every recommendation.
- **Decoupled Lifecycle:** A dedicated `/omstudio-embed/api/governance/brain/*` surface prevents coupling the Brain's high-frequency, automated ingestion/audit lifecycle to Workshop's synchronization schedules.

**Tradeoff:** A new surface requires building and owning new OMStudio backend routes and persistence tables.

**Governance Requirement:** This OMStudio-side build is a human-approved cross-system change. It **must** be tracked as a formal work item and approved by a superadmin before deploying the changes to the `.242` OMStudio edge.

---

## 1. Full REST Contract (OMStudio-Side)

This is the authoritative specification OMStudio must implement to match the deployed Brain client (`src/governance/omstudioClient.js`).

**Base URL:** The internal LAN base is `http://192.168.1.242/omstudio-embed`. Nginx on `.242` must route `/omstudio-embed/api/governance/brain/*` to the OMStudio application. The Brain's circuit breaker **hard-blocks** external/public IPs in production; it will only connect to an RFC1918 LAN address.

**Authentication:** All endpoints expect an `Authorization: Bearer <OMSTUDIO_SERVICE_TOKEN>` header.

### 1.1. Emit Audit Event
- **Method & Path:** `POST /omstudio-embed/api/governance/brain/audit-events`
- **Purpose:** Receives an append-only record of *every* Brain decision (mirroring `decision_memory`).
- **Idempotency:** The Brain may retry on transport failure. OMStudio should ideally deduplicate on `decision.decision_id` + `decision.session_id`, but appending duplicates is acceptable for audit logs.

**Request JSON Schema (Emitted by Brain):**
```json
{
  "type": "brain_audit_event",
  "emitted_at": "2026-06-18T00:00:00.000Z",
  "decision": {
    "decision_id": 123,
    "session_id": "sess-abc",
    "classification": "requires_human_superadmin",
    "recommendation": "Proposal touches a human-only domain...",
    "rationale": "protected_concern=...; owning_system=...",
    "doctrine_rule": "authority.human_only_domains#routing",
    "owning_system": "OMAI",
    "requires_omstudio": true
  }
}
```

**Response JSON Schema (Expected by Brain):**
```json
{
  "id": "OMS-AUDIT-1001" // Optional: returned as `ref` to the Brain
}
```
- **Status Codes:** `201 Created` (or `200 OK`)

### 1.2. Submit Approval Request
- **Method & Path:** `POST /omstudio-embed/api/governance/brain/approval-requests`
- **Purpose:** Opens a governance approval request for human-only or Tier 0 proposals.
- **Idempotency:** OMStudio should deduplicate on `request.approval_local_id` + `request.source_decision_id` to prevent duplicate approval tickets.

**Request JSON Schema (Emitted by Brain):**
```json
{
  "type": "brain_approval_request",
  "submitted_at": "2026-06-18T00:00:00.000Z",
  "request": {
    "approval_local_id": 42,
    "source_decision_id": 123,
    "session_id": "sess-abc",
    "classification": "requires_human_superadmin",
    "domains": "routing,schema",
    "proposal_summary": "[requires_human_superadmin] OMAI: Proposal touches..."
  }
}
```

**Response JSON Schema (Expected by Brain):**
```json
{
  "id": "OMS-APP-2002" // Returned as `ref` to the Brain
}
```
- **Status Codes:** `201 Created` (or `200 OK`)

### 1.3. Get Approval Status (Optional Polling Fallback)
- **Method & Path:** `GET /omstudio-embed/api/governance/brain/approval-requests/:ref`
- **Purpose:** Allows the Brain to poll for status. **Note:** The Brain's `getApprovalStatus` supports this, but the primary, recommended design is for OMStudio to push decisions via webhook (see Section 4).
- **Response JSON Schema:**
```json
{
  "state": "APPROVED" // Must map to SUBMITTED, APPROVED, REJECTED, EXPIRED, WITHDRAWN
}
```

**Status Enum Mapping (`src/governance/approvalStateMachine.js`):**
The Brain normalizes incoming decisions:
- `APPROVE` / `APPROVED` → `APPROVED`
- `REJECT` / `REJECTED` / `DENY` / `DENIED` → `REJECTED`
- `EXPIRE` / `EXPIRED` → `EXPIRED`
- `WITHDRAW` / `WITHDRAWN` → `WITHDRAWN`

---

## 2. Behavior Confirmation

The deployment team's assumptions are confirmed based on the deployed code (`src/orchestrator/orchestrator.js` and `src/ai/redactor.js`):

1. **Auto-safe recommendations:** Emits an **audit event only**. It does **not** open an approval request. (`executed` is always `false`).
2. **Human-only + Tier 0:** Emits an **audit event AND** submits an **approval request**.
3. **Redaction:** **All outbound payloads are redacted before egress.** Secrets (e.g., `DB_PASSWORD`, Stripe keys, JWTs) and tenant identifiers (`church_id`, `om_church_*`) are replaced with `[REDACTED]` or `[TENANT_REDACTED]`.
4. **Service Token:** The `OMSTUDIO_SERVICE_TOKEN` is sent **only** in the `Authorization: Bearer` header. It is explicitly on the never-log list and is never placed in the JSON body.

*(Optional fields OMStudio may add to responses: `message`, `created_at`. The Brain ignores unknown fields).*

---

## 3. `OMSTUDIO_SERVICE_TOKEN` Issuance Model (Proposal)

- **Format:** A signed JWT (or cryptographically secure opaque token).
- **Issuer:** OMStudio (minting a dedicated Brain service credential).
- **Scopes:** `write:brain-audit`, `write:brain-approvals` (Least privilege; **NOT** `super_admin`).
- **Expiry/Rotation:** Long-lived (e.g., 6-12 months) with a documented rotation policy.
- **Storage:** Stored on auth01 at `/etc/om-brain/om-brain.env` with mode `0600`, owned by the dedicated `om-brain` service user.
- **Header:** Sent by the Brain as `Authorization: Bearer <token>`.
- **Governance:** Minting and rotating this token is a human-governed action requiring superadmin approval.

---

## 4. Webhook Routing (.242 OMStudio -> auth01 127.0.0.1:8390)

The Brain binds to `127.0.0.1:8390` by design. OMStudio must push superadmin decisions to the Brain.

**Expected Webhook Payload (`POST /governance/approvals/:id/ingest-status`):**
```json
{
  "decision": "approved", // or rejected, expired, withdrawn
  "source": "omstudio_ingest",
  "omstudio_ref": "OMS-APP-2002",
  "note": "Superadmin approved via UI"
}
```
*Note: The Brain's state machine strictly rejects transitions to APPROVED/REJECTED if the source is the Brain itself. Only external ingest can move `SUBMITTED` -> `APPROVED`.*

### Recommended Routing: Hardened Internal Nginx
Deploy an internal Nginx block on auth01 that exposes **only** the ingest endpoint to the `.242` IP.

```nginx
server {
    listen 8391; # Internal LAN port
    server_name 192.168.1.254;

    # Restrict to OMStudio edge
    allow 192.168.1.242;
    deny all;

    location ~ ^/governance/approvals/[0-9]+/ingest-status$ {
        proxy_pass http://127.0.0.1:8390;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /health {
        proxy_pass http://127.0.0.1:8390/health;
    }

    location / {
        return 403; # Block everything else
    }
}
```
*(TLS is recommended for LAN transit if supported by internal PKI).*

### Alternatives
- **Alternative A (Polling):** Brain polls OMStudio via `GET /approval-requests/:ref`. Simpler attack surface (no inbound port on auth01), but introduces latency.
- **Alternative B (Shared Secret):** Webhook requires a shared secret header (e.g., `X-Webhook-Secret`) validated by Nginx before proxying to the Brain.

---

## 5. Minimum Bar to Flip `OMSTUDIO_TRANSPORT=dryrun -> http`

To safely transition the Brain from offline outbox to live OMStudio integration, complete this checklist:

- [ ] **OMStudio Endpoints Live:** The three `POST` routes exist on `.242` and return the expected schemas.
- [ ] **Service Token Provisioned:** Token minted, scoped appropriately, and stored in `/etc/om-brain/om-brain.env`.
- [ ] **Edge Routing Configured:** Nginx on `.242` routes `/omstudio-embed/api/governance/brain/*` to the OMStudio backend.
- [ ] **Webhook Routing Configured:** Nginx on auth01 exposes the ingest endpoint to `.242` (or polling is fully implemented).
- [ ] **Redaction Verified:** A dry-run test confirms no secrets/tenant IDs leak.
- [ ] **Governance Tracked:** A formal work item is linked, and superadmin sign-off is recorded in OMStudio.

---

## 6. OMStudio Contract Confirmation Checklist

Use this table to verify the live OMStudio API matches the Brain's assumed contract.

| Endpoint / Component | Expected (Per Contract) | Observed on Live OMStudio | Match? (Y/N) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Base URL** | `http://192.168.1.242/omstudio-embed` | | | Must be LAN/RFC1918 |
| **Auth Header** | `Authorization: Bearer <token>` | | | |
| **POST Audit Event** | `/api/governance/brain/audit-events` | | | |
| Audit Request Body | `{ type, emitted_at, decision }` | | | |
| Audit Response | `201 Created` or `200 OK` | | | |
| **POST Approval** | `/api/governance/brain/approval-requests` | | | |
| Approval Req Body | `{ type, submitted_at, request }` | | | |
| Approval Response | `201 Created` or `200 OK` | | | |
| **Webhook Ingest** | `POST /governance/approvals/:id/ingest-status` | | | Brain endpoint |
| Webhook Payload | `{ decision, source, omstudio_ref }` | | | |

---

## 7. `BRAIN_OPS_JWT` Recommendation

**Recommendation:** Do **not** reuse the `omsvc@` superadmin account. Create a **dedicated, read-only service account** for the Brain.
- **Required Scopes:** `GET /api/platform/events`, `GET /api/deploy-runs`, `GET /api/platform/inventory`, and `WS /ws/omai-logger`.
- **Minting:** Mint a scoped service-account token via OMAI admin.
- **Storage:** Store securely in `/etc/om-brain/om-brain.env` on auth01.
- **Governance:** This is a human-governed identity/auth change.

---

## 8. `JWT_ACCESS_SECRET` Flag

**FLAG ONLY:** Production OMAI currently uses the default `change_me_access_256bit` (23 chars). This is a weak, shared, default secret.

**Recommendation:** Rotate to a strong, cryptographically secure 256-bit secret **before** treating Brain ingestion as production-grade.
- **DO NOT AUTO-ROTATE.** This requires human sign-off.
- **Rotation Procedure:** If OMAI supports a dual-secret grace period, add the new secret, wait for active sessions to cycle, then remove the old secret. Otherwise, schedule a maintenance window, force re-auth, and re-mint the Brain's `BRAIN_OPS_JWT`.

---

## 9. Log WebSocket Auth Contract

**Current Brain Attempt:** The deployed `logAdapter.js` attempts to authenticate by sending the `BRAIN_OPS_JWT` in the HTTP handshake headers:
`Authorization: Bearer <token>`

**Confirmation Needed:** The OMAI team must confirm if this matches the live `wss://192.168.1.239:7060/ws/omai-logger` endpoint. Alternative common WS auth patterns include query parameters (`?token=...`) or `Sec-WebSocket-Protocol` headers.
- **Recommendation:** Keep `BRAIN_ENABLE_LOG_ADAPTER=false` until the auth mechanism is confirmed.
- **Backpressure:** The Brain adapter already implements exponential backoff on disconnects and is non-fatal if the WS fails.

---

## 10. Deploy-Runs 500 Error

**Observation:** `GET .239:7060/api/deploy-runs` returns a `500` error, while events/inventory return `200`.
**Root-Cause Hypothesis:** This is likely an OMAI-side issue, such as a missing/unmigrated table (e.g., `om_daily_deploy_runs`) or query drift on production.
**Verdict:** The Brain's `eventAdapter.js` correctly treats this as **NON-FATAL**. It logs a warning and continues polling `/events`. A single failing read will not crash the auditor. The OMAI team should investigate the 500 error on their backend.

---

## 11. Doctrine Classification Summary

| Item | Classification | Requirement Before Deploy |
| :--- | :--- | :--- |
| OMStudio Endpoint Build | Human-approved cross-system change | Tracked work item + superadmin approval |
| Service Token Issuance | Human-approved auth change | Tracked work item + superadmin approval |
| Webhook Nginx on auth01 | Human-approved routing change | Tracked work item + superadmin approval |
| Dryrun -> HTTP Flip | Config change | Superadmin sign-off |
| `BRAIN_OPS_JWT` Account | Human-approved identity change | Tracked work item + superadmin approval |
| `JWT_ACCESS_SECRET` Rotate | Human-approved secrets change | Tracked work item + superadmin approval |
| Log WS Enablement | Config change | Confirm WS auth contract first |
| Deploy-Runs Fix | OMAI backend fix | Tracked work item for OMAI team |

---

## 12. OMStudio Server-Side Implementation Plan (Proposal)

This is a buildable specification for the OMStudio engineering team to implement Fork A.

### Persistence Schema (Append-Only Mirror)
```sql
CREATE TABLE brain_audit_events (
    id SERIAL PRIMARY KEY,
    brain_decision_id INT NOT NULL,
    session_id VARCHAR(255),
    classification VARCHAR(50),
    payload JSONB NOT NULL,
    emitted_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE brain_approval_requests (
    id SERIAL PRIMARY KEY,
    brain_approval_local_id INT NOT NULL,
    source_decision_id INT NOT NULL,
    classification VARCHAR(50),
    domains VARCHAR(255),
    proposal_summary TEXT,
    state VARCHAR(20) DEFAULT 'SUBMITTED',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE brain_approval_status_history (
    id SERIAL PRIMARY KEY,
    approval_request_id INT REFERENCES brain_approval_requests(id),
    from_state VARCHAR(20),
    to_state VARCHAR(20) NOT NULL,
    actor VARCHAR(255) NOT NULL, -- Superadmin who clicked approve/reject
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Route Handlers (Pseudocode)
**1. Audit Ingest:**
```javascript
app.post('/api/governance/brain/audit-events', requireBrainToken, async (req, res) => {
    const { decision, emitted_at } = req.body;
    const id = await db.insert('brain_audit_events', { ...decision, emitted_at });
    res.status(201).json({ id: `OMS-AUDIT-${id}` });
});
```

**2. Approval Ingest:**
```javascript
app.post('/api/governance/brain/approval-requests', requireBrainToken, async (req, res) => {
    const { request, submitted_at } = req.body;
    const id = await db.insert('brain_approval_requests', { ...request });
    res.status(201).json({ id: `OMS-APP-${id}` });
});
```

**3. Superadmin UI Action -> Webhook Outbound:**
When a superadmin clicks "Approve" in the OMStudio UI:
```javascript
async function handleSuperadminDecision(approvalId, decisionStr, superadminUser) {
    // 1. Update local state
    await db.update('brain_approval_requests', { state: decisionStr }, { id: approvalId });
    await db.insert('brain_approval_status_history', { to_state: decisionStr, actor: superadminUser });

    // 2. Trigger webhook to Brain on auth01
    await fetch(`http://192.168.1.254:8391/governance/approvals/${brainLocalId}/ingest-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            decision: decisionStr,
            source: 'omstudio_ingest',
            omstudio_ref: `OMS-APP-${approvalId}`,
            note: `Approved by ${superadminUser}`
        })
    });
}
```

---

## Next Steps (Recommended Order)

1. **OMStudio Engineering:** Review Section 12 and build the `/omstudio-embed/api/governance/brain/*` endpoints.
2. **OMAI/Auth Team:** Provision the dedicated `BRAIN_OPS_JWT` read-only account and plan the `JWT_ACCESS_SECRET` rotation.
3. **Infrastructure Team:** Deploy the Nginx webhook route on auth01 (Section 4).
4. **Integration Testing:** Run the Brain in `http` transport mode against a staging OMStudio environment to verify the contract checklist (Section 6).
5. **Production Deploy:** Record superadmin approval, flip `OMSTUDIO_TRANSPORT=http`, and monitor the audit logs.

**Reminder:** The Brain does not authorize itself. All OMStudio builds and auth/secrets changes are human-approved, governed work items to be tracked prior to the `.242` deploy.
