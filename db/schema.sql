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
-- Optional sqlite-vec virtual tables. Created only when the sqlite-vec
-- extension loads successfully (see scripts/init-db.js). Plain BLOB columns
-- above remain the portable fallback.
-- -----------------------------------------------------------------------------
-- vec0 virtual tables are created programmatically when the extension is present.
