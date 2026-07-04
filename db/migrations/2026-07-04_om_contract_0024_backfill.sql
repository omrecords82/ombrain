-- =============================================================================
-- Backfill (run-once): 2026-07-04_om_contract_0024_backfill.sql  (SQLite)
-- Classifies pre-contract legacy rows for telemetry honesty AND de-conflates the
-- overloaded event_memory.`correlation` column. Run ONCE, AFTER the structural
-- migration (2026-07-04_om_contract_0024_context_envelope.sql) and IDEALLY before
-- (or together with) the app deploy that begins stamping the envelope.
--
-- TELEMETRY HONESTY (OM-CONTRACT-0024 §3): legacy / untracked rows are stamped
--   context_origin='generated', context_quality='legacy_fallback' so they never
--   inflate the "properly instrumented" (complete) figures.
--
-- SAFETY
--   * All statements are guarded (WHERE ... IS NULL) so they only touch rows that
--     were never given envelope data. Re-running is a no-op.
--   * decision_memory is APPEND-ONLY and is intentionally ABSENT here — its legacy
--     rows keep context_origin = NULL, which readers interpret as legacy_fallback.
--     Attempting to UPDATE it would raise: "decision_memory is append-only".
--   * Wrap in a transaction; verify counts (see validation queries) before COMMIT.
-- =============================================================================

BEGIN TRANSACTION;

-- (a) event_memory: recover the legacy overloaded `correlation` value into the
--     explicit request_id lane (best-effort; historically it held request/item/run
--     ids). context_session_id is left NULL for legacy rows (unknowable).
UPDATE event_memory
   SET request_id = correlation
 WHERE request_id IS NULL
   AND correlation IS NOT NULL
   AND TRIM(correlation) <> '';

-- (b) event_memory: stamp legacy rows as honest fallback.
UPDATE event_memory
   SET context_origin  = 'generated',
       context_quality = 'legacy_fallback'
 WHERE context_origin IS NULL;

-- (c) work_memory: stamp legacy rows as honest fallback.
UPDATE work_memory
   SET context_origin  = 'generated',
       context_quality = 'legacy_fallback'
 WHERE context_origin IS NULL;

-- ---------------------------------------------------------------------------
-- VALIDATION (run inside the transaction; ROLLBACK if unexpected, else COMMIT):
--   SELECT context_quality, COUNT(*) FROM event_memory    GROUP BY context_quality;
--   SELECT context_quality, COUNT(*) FROM work_memory     GROUP BY context_quality;
--   -- decision_memory: legacy rows should remain NULL (append-only, expected):
--   SELECT COUNT(*) AS legacy_null FROM decision_memory WHERE context_origin IS NULL;
-- ---------------------------------------------------------------------------

COMMIT;
