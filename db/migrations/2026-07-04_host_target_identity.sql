-- =============================================================================
-- Migration: 2026-07-04_host_target_identity.sql  (SQLite)
-- Adds first-class target-identity columns to event_memory so every
-- host.unreachable / host.recovered event identifies the affected host
-- (name + IP + service) and the vantage point that observed it.
--
-- DESIGN NOTES
--   * Additive only: no column renamed/dropped; legacy consumers unaffected.
--   * target_identity_status partitions rows:
--       'producer_provided' — producer emitted a full identity envelope
--       'resolved'          — om-brain resolved identity via inventory/hosts.json
--       'malformed'         — no target could be determined (never group these
--                             into normal host incidents)
--       NULL                — legacy row / event type without a target concept
--   * SQLite ALTER TABLE ADD COLUMN is not IF-NOT-EXISTS guarded; the migration
--     runner treats "duplicate column name" as safe/expected on re-run.
-- =============================================================================

ALTER TABLE event_memory ADD COLUMN target_name            TEXT;  -- registry/service key (e.g. omstudio, backup-nfs)
ALTER TABLE event_memory ADD COLUMN target_ip              TEXT;  -- affected host IP (e.g. 192.168.1.242)
ALTER TABLE event_memory ADD COLUMN target_host            TEXT;  -- DNS hostname (e.g. omstudio-primary.local)
ALTER TABLE event_memory ADD COLUMN target_service         TEXT;  -- app/service identity when known
ALTER TABLE event_memory ADD COLUMN check_method           TEXT;  -- ping | tcp | http | ssh | tcp-probe | ...
ALTER TABLE event_memory ADD COLUMN checked_from           TEXT;  -- vantage host that observed the failure
ALTER TABLE event_memory ADD COLUMN target_identity_status TEXT;  -- producer_provided | resolved | malformed | NULL

CREATE INDEX IF NOT EXISTS idx_event_target_ip       ON event_memory(target_ip);
CREATE INDEX IF NOT EXISTS idx_event_type_target     ON event_memory(event_type, target_ip);
CREATE INDEX IF NOT EXISTS idx_event_identity_status ON event_memory(target_identity_status);
