-- =============================================================================
-- OrthodoxMetrics Brain — Phase 1 memory schema (SQLite)
-- Five memory layers per Brain Specification v1.1 Section 5.
-- Vector embeddings are stored via sqlite-vec when available; otherwise the
-- data-access layer falls back to plain BLOB vectors + pure-JS cosine search.
-- This schema is store-agnostic for the vector column so both paths work.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 1. Doctrine memory — immutable rules (loaded from local doctrine text).
--    Used by RAG retrieval. Treated as read-only after init-db.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctrine_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key      TEXT NOT NULL,            -- e.g. "authority.human_only.schema"
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,            -- the doctrine text chunk
  source_ref    TEXT NOT NULL,           -- e.g. "OM-DOCTRINE-0001 / spec §8"
  embedding     BLOB,                    -- float32 vector (nullable until embedded)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doctrine_rule_key ON doctrine_memory(rule_key);

-- -----------------------------------------------------------------------------
-- 2. System-truth memory — cached architecture/routing/RBAC/env-contract facts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_truth_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT NOT NULL,           -- architecture | routing | rbac | env | action_catalog | tenant | incident
  fact_key      TEXT NOT NULL,           -- stable identifier
  body          TEXT NOT NULL,           -- human-readable fact
  source_ref    TEXT NOT NULL,           -- attachment file reference
  embedding     BLOB,
  refreshed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_systruth_key ON system_truth_memory(domain, fact_key);

-- -----------------------------------------------------------------------------
-- 3. Event memory — rolling window of ingested events / log correlations.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,           -- events | deploy_runs | log_ws | inventory
  event_type    TEXT,
  severity      TEXT,
  church_id     TEXT,                    -- nullable; redaction guards tenant exposure
  correlation   TEXT,                    -- request_id / item_id / run id when present
  payload_json  TEXT NOT NULL,           -- REDACTED payload (never-log secrets stripped)
  observed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_event_observed ON event_memory(observed_at);
CREATE INDEX IF NOT EXISTS idx_event_type ON event_memory(event_type);

-- -----------------------------------------------------------------------------
-- 4. Work memory — active diagnostic sessions linked to work-item context.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_memory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL UNIQUE,  -- diagnostic session id
  work_item_ref   TEXT,                  -- OMAI Daily item id / change set code (CS-NNNN)
  incident_tier   TEXT,                  -- T0..T4 (see 16-brain-incident-tiers)
  state           TEXT NOT NULL,         -- open | analyzing | recommended | escalated | closed
  context_json    TEXT NOT NULL,         -- REDACTED incident/log context
  opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_state ON work_memory(state);

-- -----------------------------------------------------------------------------
-- 5. Decision memory — APPEND-ONLY auditable ledger of every recommendation,
--    with rationale + the SPECIFIC doctrine rule applied. Never updated/deleted.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_memory (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT,              -- links to work_memory.session_id
  classification      TEXT NOT NULL,     -- auto_safe_recommendation | requires_human_superadmin | tier0_halt_escalate | never_auto | informational
  recommendation      TEXT NOT NULL,     -- what the Brain proposes (NEVER executed by the Brain)
  rationale           TEXT NOT NULL,     -- why
  doctrine_rule       TEXT NOT NULL,     -- specific rule applied (deterministic engine)
  owning_system       TEXT,              -- OM | OMAI | OMStudio | cross-system
  verification_steps  TEXT,              -- how a human should verify (verification playbook)
  model_advisory      TEXT,              -- secondary LLM note (advisory only, non-authoritative)
  requires_omstudio   INTEGER NOT NULL DEFAULT 0, -- 1 = "requires human superadmin approval via OMStudio"
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_session ON decision_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_decision_class ON decision_memory(classification);

-- Append-only guard: forbid UPDATE and DELETE on the decision ledger.
CREATE TRIGGER IF NOT EXISTS decision_memory_no_update
BEFORE UPDATE ON decision_memory
BEGIN
  SELECT RAISE(ABORT, 'decision_memory is append-only (OM-DOCTRINE-0001): UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS decision_memory_no_delete
BEFORE DELETE ON decision_memory
BEGIN
  SELECT RAISE(ABORT, 'decision_memory is append-only (OM-DOCTRINE-0001): DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- 6. Approval requests — OMStudio governance surface (Phase 1 governance step).
--    Created for every proposal the DETERMINISTIC engine classified as
--    human-only / requires-superadmin, or any Tier 0 escalation. The row's
--    CURRENT state is a denormalized convenience; the AUTHORITATIVE history is
--    the append-only approval_status_history table. The Brain NEVER sets
--    APPROVED/REJECTED itself — those arrive only by ingesting an OMStudio
--    status (see omstudioClient + approval state machine).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  source_decision_id  INTEGER,            -- FK -> decision_memory.id
  session_id          TEXT,               -- links to work_memory.session_id
  classification      TEXT NOT NULL,      -- which human-only domain / tier0
  domains             TEXT,               -- comma-joined human-only domains
  proposal_summary    TEXT NOT NULL,      -- REDACTED summary (no secrets/tenant ids)
  state               TEXT NOT NULL,      -- current state (state machine)
  omstudio_ref        TEXT,               -- id returned by OMStudio or outbox ref
  FOREIGN KEY (source_decision_id) REFERENCES decision_memory(id)
);
CREATE INDEX IF NOT EXISTS idx_approval_state ON approval_requests(state);
CREATE INDEX IF NOT EXISTS idx_approval_decision ON approval_requests(source_decision_id);

-- The current-state column may transition (PENDING_SUBMISSION -> SUBMITTED -> ...)
-- but DELETE is forbidden: approval requests are never destroyed. State changes
-- are ALSO recorded as new history rows below (append-only), so the row's column
-- is only ever advanced through the deterministic state machine in code.
CREATE TRIGGER IF NOT EXISTS approval_requests_no_delete
BEFORE DELETE ON approval_requests
BEGIN
  SELECT RAISE(ABORT, 'approval_requests is non-deletable (OM-DOCTRINE-0001): DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- 7. Approval status history — APPEND-ONLY ledger of every state transition.
--    Each transition is a NEW row (never an overwrite), capturing from/to state,
--    the source of the change (brain_submit | omstudio_ingest | dryrun_sim),
--    and an optional external reference. APPROVED/REJECTED rows may only be
--    written with source != 'brain' (enforced in code).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_status_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id         INTEGER NOT NULL,   -- FK -> approval_requests.id
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  from_state          TEXT,               -- null for initial creation
  to_state            TEXT NOT NULL,
  source              TEXT NOT NULL,      -- brain_submit | omstudio_ingest | dryrun_sim | create
  note                TEXT,               -- REDACTED note
  omstudio_ref        TEXT,
  FOREIGN KEY (approval_id) REFERENCES approval_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_apphist_approval ON approval_status_history(approval_id);

CREATE TRIGGER IF NOT EXISTS approval_status_history_no_update
BEFORE UPDATE ON approval_status_history
BEGIN
  SELECT RAISE(ABORT, 'approval_status_history is append-only (OM-DOCTRINE-0001): UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS approval_status_history_no_delete
BEFORE DELETE ON approval_status_history
BEGIN
  SELECT RAISE(ABORT, 'approval_status_history is append-only (OM-DOCTRINE-0001): DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- 8. OMStudio audit mirror — APPEND-ONLY local mirror of every audit event
--    emitted to the OMStudio governance surface (mirrors decision_memory). Gives
--    a local, tamper-evident record of what was surfaced for audit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS omstudio_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  kind                TEXT NOT NULL,      -- audit_event | approval_request
  source_decision_id  INTEGER,
  classification      TEXT,
  transport           TEXT NOT NULL,      -- dryrun | http
  omstudio_ref        TEXT,               -- returned id / outbox ref
  payload_json        TEXT NOT NULL       -- REDACTED payload that was transmitted
);
CREATE INDEX IF NOT EXISTS idx_omaudit_kind ON omstudio_audit(kind);

CREATE TRIGGER IF NOT EXISTS omstudio_audit_no_update
BEFORE UPDATE ON omstudio_audit
BEGIN
  SELECT RAISE(ABORT, 'omstudio_audit is append-only (OM-DOCTRINE-0001): UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS omstudio_audit_no_delete
BEFORE DELETE ON omstudio_audit
BEGIN
  SELECT RAISE(ABORT, 'omstudio_audit is append-only (OM-DOCTRINE-0001): DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- Optional sqlite-vec virtual tables. Created only when the sqlite-vec
-- extension loads successfully (see scripts/init-db.js). Plain BLOB columns
-- above remain the portable fallback.
-- -----------------------------------------------------------------------------
-- vec0 virtual tables are created programmatically when the extension is present.

-- -----------------------------------------------------------------------------
-- Phase 2 memory layer tables (TODO-DELEGATE §1 — append only; not deployed yet)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS task_memory (
  id          TEXT PRIMARY KEY,
  ref_key     TEXT,
  title       TEXT,
  body        TEXT,
  due_at      TEXT,
  status      TEXT,
  source      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_memory (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE,
  title       TEXT,
  body        TEXT,
  tags        TEXT,
  source      TEXT,
  embedding   BLOB,
  version     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procedure_memory (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT UNIQUE,
  title                 TEXT,
  intent_key            TEXT,
  mode                  TEXT,
  trigger_examples      TEXT,
  procedure_body        TEXT,
  commands_json         TEXT,
  required_permissions  TEXT,
  risk_level            TEXT,
  validation_steps      TEXT,
  source_decision_id    TEXT,
  source_type           TEXT,
  confidence            REAL,
  approved              INTEGER,
  approved_by           TEXT,
  approved_at           TEXT,
  usage_count           INTEGER DEFAULT 0,
  last_used_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS correction_memory (
  id                  TEXT PRIMARY KEY,
  source_decision_id  TEXT,
  session_id          TEXT,
  question_type       TEXT,
  verdict             TEXT,
  original_output     TEXT,
  correction          TEXT,
  correction_source   TEXT,
  correction_version  INTEGER DEFAULT 1,
  active              INTEGER DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS theological_memory (
  id          TEXT PRIMARY KEY,
  source      TEXT,
  source_ref  TEXT,
  book        TEXT,
  chapter     INTEGER,
  verse_start INTEGER,
  verse_end   INTEGER,
  topic_tags  TEXT,
  body        TEXT,
  language    TEXT,
  embedding   BLOB,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_theological_source ON theological_memory(source);
CREATE INDEX IF NOT EXISTS idx_theological_book_chapter ON theological_memory(book, chapter);

CREATE TABLE IF NOT EXISTS church_memory (
  id                    TEXT PRIMARY KEY,
  place_id              TEXT UNIQUE,
  name                  TEXT,
  address               TEXT,
  city                  TEXT,
  state                 TEXT,
  zip                   TEXT,
  country               TEXT,
  lat                   REAL,
  lng                   REAL,
  phone                 TEXT,
  website               TEXT,
  google_maps_url       TEXT,
  rating                REAL,
  rating_count          INTEGER,
  jurisdiction          TEXT,
  calendar_type         TEXT,
  canonical             INTEGER,
  service_schedule_json TEXT,
  opening_hours_json    TEXT,
  hours_source          TEXT,
  last_fetched_at       TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_church_lat_lng ON church_memory(lat, lng);
CREATE INDEX IF NOT EXISTS idx_church_zip ON church_memory(zip);
CREATE INDEX IF NOT EXISTS idx_church_place_id ON church_memory(place_id);
CREATE INDEX IF NOT EXISTS idx_church_jurisdiction ON church_memory(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_church_calendar_type ON church_memory(calendar_type);

CREATE TABLE IF NOT EXISTS btw_queue (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  btw_id      TEXT,
  question    TEXT,
  mode        TEXT,
  answer      TEXT,
  answered    INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_btw_session ON btw_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_btw_answered ON btw_queue(answered);
