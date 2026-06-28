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

-- =============================================================================
-- PHASE 2 — Extended memory layers (Self-Learning, Theological, Calendar, etc.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 9. task_memory — active work items and obligations tracked by the Brain.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_memory (
  id              TEXT PRIMARY KEY,           -- UUID
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'open', -- open | in_progress | blocked | done | cancelled
  priority        TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  assigned_to     TEXT,                       -- operator or system identifier
  due_at          TEXT,                       -- ISO-8601 datetime
  tags_json       TEXT,                       -- JSON array of string tags
  source          TEXT,                       -- how it was created: manual | ingest | brain
  source_ref      TEXT,                       -- external reference (ticket id, session id, etc.)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task_memory(status);
CREATE INDEX IF NOT EXISTS idx_task_priority ON task_memory(priority);

-- -----------------------------------------------------------------------------
-- 10. knowledge_memory — durable facts, documentation, and operator-taught knowledge.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_memory (
  id              TEXT PRIMARY KEY,           -- UUID
  slug            TEXT NOT NULL UNIQUE,       -- stable human-readable key
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,              -- the knowledge content
  category        TEXT NOT NULL,              -- platform | ops | theology | general
  tags_json       TEXT,                       -- JSON array
  source_ref      TEXT,                       -- file path, URL, or session id
  confidence      REAL NOT NULL DEFAULT 1.0,  -- 0.0–1.0
  embedding       BLOB,                       -- float32 vector (nullable)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_memory(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_slug ON knowledge_memory(slug);

-- -----------------------------------------------------------------------------
-- 11. procedure_memory — self-learned repeatable workflows (retrieval-first pipeline).
--     Draft procedures require approval before they are used in production.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procedure_memory (
  id                  TEXT PRIMARY KEY,       -- UUID
  slug                TEXT NOT NULL UNIQUE,   -- stable identifier e.g. "full-system-status-check"
  title               TEXT NOT NULL,
  intent_key          TEXT NOT NULL,          -- classifier intent that triggers this procedure
  mode                TEXT NOT NULL,          -- knowledge | technical | ops
  trigger_examples    TEXT,                   -- JSON array of example phrases
  procedure_body      TEXT NOT NULL,          -- human-readable procedure description
  commands_json       TEXT,                   -- JSON array of {cmd, description, expected_output}
  required_permissions TEXT,                  -- JSON array of required permission strings
  risk_level          TEXT NOT NULL DEFAULT 'low', -- low | medium | high | destructive
  validation_steps    TEXT,                   -- JSON array of validation checks
  source_decision_id  TEXT,                   -- FK -> decision_memory.id (origin)
  source_type         TEXT,                   -- llm_extracted | operator_taught | imported
  confidence          REAL NOT NULL DEFAULT 0.0, -- 0.0–1.0
  approved            INTEGER NOT NULL DEFAULT 0, -- 0=draft, 1=approved
  approved_by         TEXT,
  approved_at         TEXT,
  usage_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_procedure_slug ON procedure_memory(slug);
CREATE INDEX IF NOT EXISTS idx_procedure_intent ON procedure_memory(intent_key);
CREATE INDEX IF NOT EXISTS idx_procedure_approved ON procedure_memory(approved);
CREATE INDEX IF NOT EXISTS idx_procedure_risk ON procedure_memory(risk_level);

-- -----------------------------------------------------------------------------
-- 12. correction_memory — APPEND-ONLY ledger of known mistakes and operator overrides.
--     Used in the retrieval-first pipeline to override conflicting knowledge.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS correction_memory (
  id                  TEXT PRIMARY KEY,       -- UUID
  decision_id         TEXT,                   -- FK -> decision_memory.id (what was wrong)
  procedure_id        TEXT,                   -- FK -> procedure_memory.id (if procedure failed)
  correction_type     TEXT NOT NULL,          -- operator_override | failed_reuse | factual_error | safety_violation
  wrong_answer        TEXT NOT NULL,          -- what the Brain said / did
  correct_answer      TEXT NOT NULL,          -- what the correct answer/action is
  explanation         TEXT,                   -- why it was wrong
  submitted_by        TEXT NOT NULL,          -- operator id or 'system'
  tags_json           TEXT,                   -- JSON array for retrieval
  embedding           BLOB,                   -- float32 vector for semantic search
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  -- Spec §5 columns (migration 2026-06-27_spec5_spec6.sql)
  source_decision_id  TEXT,
  session_id          TEXT,
  question_type       TEXT,                   -- service_restart_recommendation | schema_change_governance | ...
  verdict             TEXT,                   -- incorrect | partially_correct | overconfident | stuck
  original_output     TEXT,
  correction          TEXT,
  correction_source   TEXT,                   -- operator_override | auto_loop_detect | auto_stumble_detect
  correction_version  INTEGER NOT NULL DEFAULT 1,
  active              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_correction_type ON correction_memory(correction_type);
CREATE INDEX IF NOT EXISTS idx_correction_decision ON correction_memory(decision_id);
CREATE INDEX IF NOT EXISTS idx_correction_question_type ON correction_memory(question_type);
CREATE INDEX IF NOT EXISTS idx_correction_active ON correction_memory(active);
CREATE INDEX IF NOT EXISTS idx_correction_session ON correction_memory(session_id);

-- Append-only guard: corrections are never modified or deleted.
CREATE TRIGGER IF NOT EXISTS correction_memory_no_update
BEFORE UPDATE ON correction_memory
BEGIN
  SELECT RAISE(ABORT, 'correction_memory is append-only (OM-DOCTRINE-0001): UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS correction_memory_no_delete
BEFORE DELETE ON correction_memory
BEGIN
  SELECT RAISE(ABORT, 'correction_memory is append-only (OM-DOCTRINE-0001): DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- 13. theological_memory — Orthodox Christian knowledge (scripture, catechism, councils, etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theological_memory (
  id              TEXT PRIMARY KEY,           -- UUID
  category        TEXT NOT NULL,             -- scripture | catechism | council | patristic | liturgy | belief | saint
  subcategory     TEXT,                       -- e.g. "OT", "NT", "Nicaea I", "Chrysostom", "Calendar"
  reference_key   TEXT NOT NULL,             -- e.g. "Gen.1.1", "Catechism.Q47", "Saint.John.Chrysostom"
  title           TEXT,
  body            TEXT NOT NULL,             -- the text content
  source          TEXT NOT NULL,             -- e.g. "Brenton LXX 1851", "Orthodox Saints Calendar (sample)"
  language        TEXT NOT NULL DEFAULT 'en',
  embedding       BLOB,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Spec §6 columns (migration 2026-06-27_spec5_spec6.sql)
  source_ref      TEXT,
  book            TEXT,                       -- scripture book name (e.g. "Genesis")
  chapter         INTEGER,
  verse_start     INTEGER,
  verse_end       INTEGER,
  topic_tags      TEXT                        -- comma-separated or JSON topic tags
);
CREATE INDEX IF NOT EXISTS idx_theo_category ON theological_memory(category);
CREATE INDEX IF NOT EXISTS idx_theo_ref ON theological_memory(reference_key);
CREATE INDEX IF NOT EXISTS idx_theo_book_chapter ON theological_memory(book, chapter);
CREATE INDEX IF NOT EXISTS idx_theo_topic_tags ON theological_memory(topic_tags);

-- Theological content is immutable once seeded.
CREATE TRIGGER IF NOT EXISTS theological_memory_no_update
BEFORE UPDATE ON theological_memory
BEGIN
  SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS theological_memory_no_delete
BEFORE DELETE ON theological_memory
BEGIN
  SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: DELETE forbidden');
END;

-- -----------------------------------------------------------------------------
-- 14. church_memory — Orthodox parish data (Google Places + AOB directory cache).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS church_memory (
  id              TEXT PRIMARY KEY,           -- UUID
  place_id        TEXT,                       -- Google Places place_id (nullable for AOB-only)
  name            TEXT NOT NULL,
  jurisdiction    TEXT,                       -- e.g. "OCA", "GOARCH", "ROCOR", "Antiochian"
  address         TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT NOT NULL DEFAULT 'US',
  lat             REAL,
  lng             REAL,
  phone           TEXT,
  website         TEXT,
  liturgical_calendar TEXT,                   -- Julian | Revised Julian | Gregorian
  source          TEXT NOT NULL,              -- google_places | aob_directory | manual
  last_verified   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  -- P1 church finder columns (migration 2026-06-27_p1_church_btw_schema.sql)
  google_maps_url TEXT,
  rating          REAL,
  rating_count    INTEGER,
  canonical       INTEGER,                    -- 1=canonical, 0=non-canonical, NULL=unknown
  service_schedule_json TEXT,
  opening_hours_json TEXT,
  hours_source    TEXT NOT NULL DEFAULT 'google_places',
  last_fetched_at TEXT,
  zip             TEXT
);
CREATE INDEX IF NOT EXISTS idx_church_jurisdiction ON church_memory(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_church_location ON church_memory(state, city);
CREATE INDEX IF NOT EXISTS idx_church_place_id ON church_memory(place_id);
CREATE INDEX IF NOT EXISTS idx_church_zip ON church_memory(zip);
CREATE INDEX IF NOT EXISTS idx_church_canonical ON church_memory(canonical);
CREATE INDEX IF NOT EXISTS idx_church_last_fetched ON church_memory(last_fetched_at);

-- -----------------------------------------------------------------------------
-- 15. btw_queue — "By The Way" interrupt queue for non-urgent Brain notifications.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS btw_queue (
  id              TEXT PRIMARY KEY,           -- UUID
  message         TEXT NOT NULL,             -- the notification text
  category        TEXT NOT NULL,             -- ops | theology | calendar | system | general
  priority        TEXT NOT NULL DEFAULT 'low', -- low | normal
  delivered       INTEGER NOT NULL DEFAULT 0, -- 0=pending, 1=delivered
  delivery_mode   TEXT NOT NULL DEFAULT 'next_interaction', -- next_interaction | scheduled
  deliver_at      TEXT,                       -- ISO-8601 if scheduled
  source_ref      TEXT,                       -- what triggered this BTW
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  -- Session-scoped BTW columns (migration 2026-06-27_p1_church_btw_schema.sql)
  session_id      TEXT,
  btw_id          TEXT,
  question        TEXT,
  mode            TEXT,
  answer          TEXT,
  answered        INTEGER NOT NULL DEFAULT 0,
  answered_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_btw_delivered ON btw_queue(delivered);
CREATE INDEX IF NOT EXISTS idx_btw_deliver_at ON btw_queue(deliver_at);
CREATE INDEX IF NOT EXISTS idx_btw_session ON btw_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_btw_answered ON btw_queue(answered);

-- -----------------------------------------------------------------------------
-- 16. skill_memory — memorized executable scripts (bash, python, node).
--     Dry-run by default at the API layer; unsafe patterns blocked before store/run.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_memory (
  id              TEXT PRIMARY KEY,           -- UUID
  skill_key       TEXT NOT NULL UNIQUE,       -- stable slug e.g. "check-disk-usage"
  title           TEXT NOT NULL,
  description     TEXT,
  language        TEXT NOT NULL,              -- bash | python | node
  script_body     TEXT NOT NULL,              -- script source (never store secrets)
  tags_json       TEXT,                       -- JSON array
  source          TEXT NOT NULL DEFAULT 'operator', -- operator | learned | import
  version         INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1, -- 0=soft-deleted
  last_run_at     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  last_exit_code  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_key ON skill_memory(skill_key);
CREATE INDEX IF NOT EXISTS idx_skill_active ON skill_memory(active);
CREATE INDEX IF NOT EXISTS idx_skill_language ON skill_memory(language);
