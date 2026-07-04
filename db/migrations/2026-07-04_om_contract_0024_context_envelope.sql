-- =============================================================================
-- Migration: 2026-07-04_om_contract_0024_context_envelope.sql  (SQLite)
-- Adds OM-CONTRACT-0024 context-envelope columns to event_memory,
-- decision_memory, and work_memory. Additive and safe on an existing DB.
--
-- Contract: docs/om-brain/OM-CONTRACT-0024-Context-Propagation.md
--
-- DESIGN NOTES
--   * Non-destructive: no column renamed/dropped. The legacy event_memory.`correlation`
--     column (historically overloaded with request/item/run ids) is PRESERVED; new
--     first-class columns partition its meaning cleanly going forward.
--   * decision_memory / work_memory already store the Session as `session_id`
--     (== context_session_id), and work_memory.`work_item_ref` == work_item_id, so
--     those are NOT re-added.
--   * SQLite has NO `ALTER COLUMN SET DEFAULT` and cannot do the MariaDB two-step
--     default trick. Quality markers are therefore added as NULLABLE (NULL == not
--     tracked / legacy). The application stamps explicit values on new writes; a
--     one-time backfill (see 2026-07-04_om_contract_0024_backfill.sql) classifies
--     legacy rows in the UPDATABLE tables.
--   * decision_memory is APPEND-ONLY (UPDATE/DELETE triggers). Its legacy rows keep
--     context_origin = NULL, which readers MUST interpret as 'generated' /
--     'legacy_fallback'. They cannot (and must not) be UPDATEd.
--   * SQLite `ALTER TABLE ADD COLUMN` is not IF-NOT-EXISTS guarded; this migration
--     is intended to run exactly once (matches repo convention). Re-running will
--     error with "duplicate column name" — that error is safe/expected.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 3. event_memory — de-conflate the overloaded `correlation` column.
--    Legacy `correlation` stays; add explicit, partitioned context columns.
-- ---------------------------------------------------------------------------
ALTER TABLE event_memory ADD COLUMN context_session_id TEXT;   -- canonical Session (ledger.Session)
ALTER TABLE event_memory ADD COLUMN correlation_id     TEXT;   -- operation/event-chain id (was mixed into `correlation`)
ALTER TABLE event_memory ADD COLUMN request_id         TEXT;   -- single HTTP request boundary (was mixed into `correlation`)
ALTER TABLE event_memory ADD COLUMN context_origin     TEXT;   -- provided | generated | repaired (NULL = legacy)
ALTER TABLE event_memory ADD COLUMN context_quality    TEXT;   -- complete | partial | legacy_fallback | invalid (NULL = legacy)

CREATE INDEX IF NOT EXISTS idx_event_ctx_session ON event_memory(context_session_id);
CREATE INDEX IF NOT EXISTS idx_event_request     ON event_memory(request_id);
CREATE INDEX IF NOT EXISTS idx_event_ctx_quality ON event_memory(context_quality);

-- ---------------------------------------------------------------------------
-- 5. decision_memory — APPEND-ONLY. session_id already == context_session_id.
--    Add transaction-grain + quality markers only. NULL legacy rows are immutable.
-- ---------------------------------------------------------------------------
ALTER TABLE decision_memory ADD COLUMN correlation_id  TEXT;
ALTER TABLE decision_memory ADD COLUMN request_id      TEXT;
ALTER TABLE decision_memory ADD COLUMN context_origin  TEXT;   -- NULL on legacy rows = 'generated'/'legacy_fallback' by convention
ALTER TABLE decision_memory ADD COLUMN context_quality TEXT;

CREATE INDEX IF NOT EXISTS idx_decision_correlation  ON decision_memory(correlation_id);
CREATE INDEX IF NOT EXISTS idx_decision_ctx_quality  ON decision_memory(context_quality);

-- ---------------------------------------------------------------------------
-- 4. work_memory — session_id == context_session_id; work_item_ref == work_item_id.
--    Add transaction-grain + quality markers (table is updatable -> backfillable).
-- ---------------------------------------------------------------------------
ALTER TABLE work_memory ADD COLUMN correlation_id  TEXT;
ALTER TABLE work_memory ADD COLUMN request_id      TEXT;
ALTER TABLE work_memory ADD COLUMN context_origin  TEXT;
ALTER TABLE work_memory ADD COLUMN context_quality TEXT;

CREATE INDEX IF NOT EXISTS idx_work_correlation ON work_memory(correlation_id);
CREATE INDEX IF NOT EXISTS idx_work_ctx_quality ON work_memory(context_quality);
