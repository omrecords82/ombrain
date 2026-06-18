# OrthodoxMetrics Brain — Phase 1 External Substrate

> **Posture (OM-DOCTRINE-0001, Phase 1):** *auditor first, planner second,
> operator last.* The Brain **observes, analyzes, explains, and recommends.**
> It **never self-authorizes** and **never executes** governed or never-auto
> actions. Authority is decided by a **deterministic rule engine in code**, not
> by the language model.

This repository is the complete, runnable Phase 1 substrate: a local Node.js
service that ingests read-only operational telemetry, recalls system truth and
doctrine, applies deterministic governance gates, produces explained
recommendations, and writes an append-only decision ledger. It is designed to be
deployed by the user's team on the confirmed inference host **auth01
(192.168.1.254)** under an isolation slice.

---

## 1. Governing precondition — APPROVED build, gates CLOSED

This build proceeds because **both governance gates are CLOSED**:

1. **Environment-boundary ambiguity resolved.** The earlier `om-dev` / `.254`
   environment-boundary ambiguity has been resolved. auth01 (192.168.1.254) is
   the **confirmed Phase 1 primary inference host**.
2. **Superadmin co-location approval GRANTED.** A human superadmin has
   **approved co-locating Brain inference on auth01** alongside Keycloak SSO and
   its PostgreSQL, on the condition that inference is confined by a hard
   `MemoryMax` / `CPUQuota` isolation slice so it can never starve the SSO/DB
   workloads.

Because co-locating inference on auth01 is a **boundary-defining act** (a
human-only domain under the doctrine), it is recorded here as the **governing
precondition** for this build and **must still be logged to OMStudio** as an
audit entry when the team performs the deploy. This README *records an
already-granted human approval*; it does not, and cannot, constitute the Brain
authorizing the change itself.

> If either gate were open, this substrate would refuse to treat auth01
> co-location as settled and would mark it `requires human superadmin approval
> via OMStudio`. The gates are closed, so the deploy runbook below is
> authorized — and still audited.

---

## 2. What the Brain is (and is not)

| The Brain **does** | The Brain **never does** |
| --- | --- |
| Ingest read-only events, deploy-runs, inventory, and logs | Mutate OM / OMAI / OMStudio surfaces |
| Recall system-truth + doctrine (RAG) | Change DB schema, nginx/routing, auth/session, billing, permissions, secrets, substrate/manifests, or delete data |
| Classify a proposed change against deterministic gates | Decide a governance gate with the model |
| Explain, and recommend *documented safe actions* | Execute **any** action, even an auto-safe one |
| Escalate to a human via OMStudio | Auto-remediate cross-tenant exposure |
| Write an append-only decision ledger | Call an external LLM or any non-LAN host |

---

## 3. Architecture

```
                 read-only ingestion (JWT bearer, redacted)
   OMAI events ┐   inventory ┐   log WS ┐
               ▼             ▼          ▼
        ┌──────────────────────────────────────┐
        │  Adapters (src/adapters/*)            │  ── every payload REDACTED on entry
        └──────────────────────────────────────┘
                          │
                          ▼
        ┌──────────────────────────────────────┐
        │  Memory (src/memory/*)  — SQLite      │
        │   1 Doctrine  2 System-Truth          │
        │   3 Event     4 Work                  │
        │   5 Decision (APPEND-ONLY ledger)     │
        └──────────────────────────────────────┘
                          │ recall
                          ▼
        ┌──────────────────────────────────────┐
        │  Orchestrator (src/orchestrator)      │  reasoning order:
        │   concern → owner → truth → AUTHORITY │  concern, owner, truth,
        └───────────────┬──────────────────────┘  deterministic authority,
            advisory    │ AUTHORITATIVE            escalate-or-propose
            (non-binding)│
                ▼        ▼
   ┌──────────────────┐ ┌───────────────────────────────────────────┐
   │ AI client        │ │ Deterministic Rule Engine (governance/*)  │
   │  + circuit       │ │  classifyChange · isAutoSafe · isNeverAuto │
   │    breaker       │ │  tenantGuard · evaluate  ← DECIDES GATES   │
   │  + redactor      │ └───────────────────────────────────────────┘
   │  LAN-only model  │
   └──────────────────┘
                          │
                          ▼
        ┌──────────────────────────────────────┐
        │  HTTP API (src/api) — READ/OBSERVE     │
        │   /health /audit/findings /diagnose    │
        │   /decisions   (no mutation routes)    │
        └──────────────────────────────────────┘
```

### The deterministic-vs-model boundary (the most important invariant)

Whether a change touches a **human-only domain** — DB schema, nginx/routing,
auth/session, billing, permissions, secrets governance, substrate/manifest/
registry edits, data deletion, or any cross-system OM↔OMAI↔OMStudio change — is
decided by pure, unit-tested code in
[`src/governance/ruleEngine.js`](src/governance/ruleEngine.js). The language
model is consulted only for an **advisory** second opinion that is attached to
the record and explicitly flagged `model_advisory_authoritative: false`.

- A model **"No"** can **never** clear a gate.
- A model **"Yes"** can **never** trigger an action.

The engine enforces, in strict precedence:

1. **Tenant sanctity** — any cross-tenant pattern (`church_id` / `om_church_*`
   mismatch) ⇒ **Tier 0 halt-and-escalate**, never auto-remediated.
2. **Never-auto actions** — DB backup/restore, NFS restore, change-set
   promote/hotfix, stop/disable required units, any `confirm_production` ⇒
   explain + escalate only.
3. **Human-only domains** ⇒ `requires human superadmin approval via OMStudio`.
4. **Auto-safe actions** — *only* `service_restart` (excluding the OM backend),
   `reconcile_stale_deploy`, `remove_maintenance_flag` ⇒ presented as a
   **recommendation**, still never executed by the Brain.
5. Otherwise ⇒ informational observation.

### Other enforced invariants

- **Circuit breaker** ([`src/ai/circuitBreaker.js`](src/ai/circuitBreaker.js)):
  inference is loopback/RFC1918 LAN only. `api.openai.com` and any non-LAN host
  are hard-blocked in production. On local-inference failure the session halts
  and escalates — **never** silently re-routes.
- **Redaction** ([`src/ai/redactor.js`](src/ai/redactor.js)): never-log secrets
  and tenant identifiers are stripped from every payload **before** it reaches
  the model, the logs, or persisted memory. Diagnostic prompts redact structured
  objects *at the source* before serialization.
- **Append-only decision ledger**: `decision_memory` is protected by SQLite
  triggers that abort `UPDATE`/`DELETE` (and has no mutation path in the pure-JS
  fallback backend).

---

## 4. Repository layout

```
om-brain/
├── README.md                      # this file
├── package.json                   # scripts: start, test, init-db
├── .env.example                   # all governed config variables
├── db/
│   └── schema.sql                 # five memory layers + append-only triggers
├── scripts/
│   └── init-db.js                 # create schema; seed doctrine + system-truth
├── src/
│   ├── index.js                   # entrypoint (wires everything)
│   ├── config/index.js            # env config (no secret ever logged)
│   ├── doctrine/om-doctrine-0001.md  # Brain-loaded doctrine (RAG source)
│   ├── adapters/                  # eventAdapter, inventoryAdapter, logAdapter (read-only)
│   ├── memory/                    # db.js, vectorStore.js, systemTruthSeed.js
│   ├── ai/                        # client.js, circuitBreaker.js, redactor.js
│   ├── governance/
│   │   ├── ruleEngine.js          # DETERMINISTIC authority gates
│   │   ├── approvalStateMachine.js# DETERMINISTIC approval lifecycle
│   │   ├── omstudioClient.js      # OMStudio audit+approval adapter (ASSUMED HTTP + dry-run)
│   │   └── governanceManager.js   # audit every decision; route approvals; ingest status
│   ├── orchestrator/orchestrator.js
│   ├── api/server.js              # read/observe HTTP API + /governance/* surface
│   └── util/logger.js             # redaction-enforcing logger
├── docs/
│   └── OMSTUDIO-INTEGRATION.md    # adapter interface, assumed payloads, webhook, state machine
├── test/                          # node:test unit + integration tests
│   ├── redactor.test.js
│   ├── ruleEngine.test.js
│   ├── circuitBreaker.test.js
│   ├── orchestrator.test.js
│   ├── approvalStateMachine.test.js
│   ├── omstudioClient.test.js
│   └── governanceFlow.test.js
└── deploy/                        # auth01 runbook
    ├── om-brain.slice             # hard MemoryMax / CPUQuota isolation
    ├── om-brain.service           # hardened unit, LAN-only egress, service user
    ├── om-brain.env.example       # production env template
    ├── deploy.sh                  # repeatable installer
    ├── teardown.sh                # rollback / teardown
    └── VERIFY.md                  # definition-of-done verification
```

---

## 5. Run instructions (local / sandbox)

Requires Node.js ≥ 20.

```bash
# 1) Install dependencies.
npm install
#   Native deps (better-sqlite3, sqlite-vec) are OPTIONAL accelerators. If they
#   cannot build on your platform, the Brain automatically falls back to a
#   pure-JS, file-backed memory store with the SAME guarantees. See §7.

# 2) Configure.
cp .env.example .env        # defaults are LAN-safe; adapters are OFF by default

# 3) Initialize memory (creates schema; seeds doctrine + system-truth).
npm run init-db

# 4) Run the test suite (deterministic governance, redaction, breaker, ledger).
npm test

# 5) Start the service.
npm start
#   Then, in another shell:
curl -s http://127.0.0.1:8390/health | jq .
curl -s -X POST http://127.0.0.1:8390/diagnose -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"omai 502"},"proposal":{"action":"service_restart","target":"omai"}}' | jq .
curl -s http://127.0.0.1:8390/decisions | jq .
```

### HTTP API (read/observe only — no mutation routes exist)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness, posture, memory backend, circuit-breaker verdict |
| GET | `/audit/findings?limit=N` | recent ingested (redacted) events |
| POST | `/diagnose` | analyze an incident/proposal → deterministic classification + explanation + recommendation + verification steps; writes a ledger entry; audits to OMStudio; routes human-only/Tier 0 to an approval request; `executed` is always `false` |
| GET | `/decisions?limit=N` | the append-only decision ledger |
| GET | `/governance/approvals?limit=N` | approval requests + current state |
| GET | `/governance/approvals/:id` | approval detail incl. redacted append-only history |
| POST | `/governance/approvals/:id/ingest-status` | apply an **externally-sourced** OMStudio status (live webhook target; `dryrun_sim` for tests). Cannot be used by the Brain to self-approve |
| GET | `/governance/audit?limit=N` | recent audit events emitted to OMStudio (local mirror) |

---

## 5a. OMStudio Governance Integration

The Brain surfaces its outputs to the OMStudio governance surface for **audit**
and routes human-only / Tier 0 proposals for **superadmin approval**. This
completes the "integrated into OMStudio governance surfaces" clause of the
Phase 1 definition-of-done. Full detail is in
[`docs/OMSTUDIO-INTEGRATION.md`](docs/OMSTUDIO-INTEGRATION.md).

**Audit vs. approval.** *Every* decision emits an AUDIT event (mirroring
`decision_memory`, also stored locally in the append-only `omstudio_audit`
table). Only `requires_human_superadmin` (human-only domains) and
`tier0_halt_escalate` additionally open an APPROVAL request. Auto-safe
recommendations are audited but open **no** approval request; `executed` stays
`false`.

**Approval lifecycle (deterministic state machine).**
`PENDING_SUBMISSION → SUBMITTED → (APPROVED | REJECTED | EXPIRED | WITHDRAWN)`.
The Brain creates a request and submits it (`→ SUBMITTED`) but **never**
self-approves: `APPROVED`/`REJECTED`/`EXPIRED` can be set **only** by ingesting
an externally-sourced OMStudio status (or, in dry-run, an explicitly
operator-simulated `dryrun_sim` input). This is enforced in pure code
(`src/governance/approvalStateMachine.js`), not by the model. Status history is
append-only.

**ASSUMED interface caveat.** The exact OMStudio audit/approval REST contract is
**not** in the provided corpus. The HTTP paths and payload shapes are an
**ASSUMED** interface isolated behind a swappable adapter
(`src/governance/omstudioClient.js`); the team **must confirm/adjust them against
the live OMStudio API** before enabling `OMSTUDIO_TRANSPORT=http`.

**Env vars** (see `.env.example`; governed ecosystem config):

| Var | Default | Meaning |
| --- | --- | --- |
| `OMSTUDIO_GOVERNANCE_BASE_URL` | `.242` edge / omstudio-embed placeholder | governance surface base URL (use the **LAN** address for `http` in prod) |
| `OMSTUDIO_SERVICE_TOKEN` | empty | governed token; bearer header only; **never-log** |
| `OMSTUDIO_TRANSPORT` | `dryrun` | `dryrun` (offline outbox) or `http` (live; assumed contract) |
| `OMSTUDIO_OUTBOX_DIR` | `./data/omstudio-outbox` | dry-run outbox directory |

**Dry-run vs http.** `dryrun` (default) writes each outbound record to the
outbox as JSON — no network call — so the whole flow is testable without a live
OMStudio. `http` POSTs to the assumed endpoints and is subject to the **circuit
breaker** (LAN/RFC1918 hosts only; external hosts refused). **Every** outbound
payload passes through the redactor first, so no never-log secret (incl.
`OMSTUDIO_SERVICE_TOKEN`) or tenant identifier (`church_id` / `om_church_*`) is
ever transmitted.

**Try it (dry-run):**

```bash
npm start
curl -s -X POST http://127.0.0.1:8390/diagnose -H 'Content-Type: application/json' \
  -d '{"incident":{"summary":"add nginx route"},"proposal":{"description":"add nginx location proxy_pass"}}' | jq '.requires_human_superadmin_approval, .omstudio'
curl -s http://127.0.0.1:8390/governance/approvals | jq .
curl -s http://127.0.0.1:8390/governance/audit | jq '.count'
# simulate an OMStudio superadmin APPROVED decision (test-only source):
curl -s -X POST http://127.0.0.1:8390/governance/approvals/1/ingest-status \
  -H 'Content-Type: application/json' \
  -d '{"decision":"approved","source":"dryrun_sim"}' | jq .
ls data/omstudio-outbox/   # outbound records
```

---

## 6. auth01 deploy runbook (192.168.1.254)

> **Precondition:** superadmin co-location approval is GRANTED (see §1). The
> deploy is a human-performed, boundary-defining act and must be **logged to
> OMStudio**. The Brain only recommends; it does not perform this deploy.

**Why an isolation slice.** auth01 co-hosts Keycloak SSO (:8080) and its
PostgreSQL on a 30 vCPU / 53 GB host. The Brain runs inside `om-brain.slice`
with a hard `MemoryMax=20G` (`MemorySwapMax=0`) and `CPUQuota=1200%` so an LLM
spike can never starve SSO/DB. Tune only with superadmin sign-off.

**Steps (run on auth01 as a sudo-capable user):**

```bash
# 0) Ensure a LOCAL inference endpoint is reachable on the LAN, e.g. Ollama on
#    127.0.0.1:11434 with the configured models pulled. (Inference install is
#    out of scope of this repo and is itself a host change to log.)

# 1) Copy this repository to auth01 (e.g. /home/<you>/om-brain) and run:
sudo ./deploy/deploy.sh
#    deploy.sh: creates the `om-brain` service user; syncs code to /opt/om-brain;
#    installs prod deps (falls back to pure-JS store if native build fails);
#    creates /var/lib/om-brain state dir; installs /etc/om-brain/om-brain.env
#    from template; installs the slice + unit; enables and starts the service.

# 2) Edit the environment file, then restart:
sudo nano /etc/om-brain/om-brain.env      # set BRAIN_LLM_BASE_URL, models, JWT
sudo systemctl restart om-brain.service

# 3) Verify against the definition-of-done:
#    follow every check in deploy/VERIFY.md
```

**Rollback / teardown:**

```bash
sudo ./deploy/teardown.sh            # stop+disable+remove unit; KEEP state & env for audit
sudo ./deploy/teardown.sh --purge    # also delete state & env (data-deletion → superadmin + OMStudio)
```

The unit additionally enforces LAN-only egress at the kernel level
(`IPAddressDeny=any` + RFC1918 allow-list) as defense-in-depth behind the
in-code circuit breaker, plus filesystem and syscall hardening and a dedicated
unprivileged service user.

---

## 7. Dependency notes / sandbox workaround

`better-sqlite3` and `sqlite-vec` are declared as **`optionalDependencies`** and
accelerate the embedded SQLite + vector store. They build cleanly in this
sandbox (the test/verify runs above used `sqlite+sqlite-vec`). On a host where
the native toolchain is unavailable:

- `npm install --omit=dev` (or the deploy script) still succeeds; the optional
  native modules are skipped.
- [`src/memory/db.js`](src/memory/db.js) detects their absence and transparently
  switches to a **pure-JS, file-backed JSON store** that implements the identical
  API, including the **append-only guarantee** for `decision_memory` (no
  UPDATE/DELETE path is exposed) and a pure-JS cosine-similarity vector search.
- `express`, `openai`, and `ws` are required runtime deps; the `openai` and `ws`
  clients are loaded lazily so unit tests and the governance core run even if a
  network client is unavailable.

The OMStudio governance client uses the built-in global `fetch` (Node ≥ 18) for
its `http` transport — no new dependency — and is injectable for tests. In the
default `dryrun` mode it makes no network call at all.

No code path ever reaches an external LLM or external OMStudio host: the circuit
breaker refuses non-LAN hosts for both the LLM and the OMStudio surface, and
inference failure escalates rather than re-routes.

---

## 8. Phase 1 definition-of-done

Work is **not** "done" merely because code compiles. Per OM-DOCTRINE-0001 and
the spec, Phase 1 done requires all of the following — each satisfied or
documented here:

1. **Implementation exists.** Full source under `src/`, schema under `db/`,
   scripts, and tests. ✔
2. **Behavior verified against real checks.** `npm test` (deterministic gates,
   redaction, circuit breaker, append-only ledger, orchestrator) plus the
   `/health`, `/diagnose`, `/decisions` smoke calls and `deploy/VERIFY.md`
   host checks. ✔ (sandbox-verified; re-run on auth01)
3. **No egress / circuit breaker proven.** External hosts blocked in code and at
   the kernel; inference failure halts + escalates. ✔
4. **Isolation enforced.** `om-brain.slice` hard `MemoryMax`/`CPUQuota`;
   dedicated service user; hardened unit. ✔
5. **Documentation + routing updated.** This README, `deploy/VERIFY.md`, and the
   seeded system-truth/routing facts. ✔
6. **Linked to governance.** Every run writes a `decision_memory` ledger entry
   citing the specific doctrine rule; human-only proposals are marked
   `requires human superadmin approval via OMStudio`. The auth01 deploy is to be
   logged to OMStudio as an audit entry. **Integrated into OMStudio governance
   surfaces:** every decision now emits an OMStudio AUDIT event (mirrored in the
   append-only `omstudio_audit` table), and human-only / Tier 0 proposals open a
   `SUBMITTED` OMStudio APPROVAL request via a deterministic state machine in
   which the Brain can never self-approve (see §5a and
   `docs/OMSTUDIO-INTEGRATION.md`). ✔
7. **Required approvals granted.** The superadmin co-location approval (§1) is
   the recorded governing precondition. ✔
8. **A reusable workflow exists.** `deploy/deploy.sh` + `deploy/teardown.sh` +
   `deploy/VERIFY.md` make the deploy repeatable and reversible. ✔

---

## 9. License

Apache-2.0. See `package.json`. Internal OrthodoxMetrics governance
(OM-DOCTRINE-0001) governs operational use.
