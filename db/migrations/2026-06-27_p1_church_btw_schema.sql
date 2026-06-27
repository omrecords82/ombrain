-- =============================================================================
-- Migration: 2026-06-27_p1_church_btw_schema.sql
-- P1-2/P1-3: Upgrade church_memory and btw_queue schemas
-- =============================================================================
-- Run on: auth01 (192.168.1.254) — om-brain SQLite DB
-- Apply with: sqlite3 /var/lib/om-brain/brain.db < 2026-06-27_p1_church_btw_schema.sql
-- Safe to re-run: all statements use IF NOT EXISTS / ADD COLUMN (SQLite ignores
--   duplicate ADD COLUMN with an error, so wrap in a transaction and check first)
-- =============================================================================

PRAGMA journal_mode=WAL;
BEGIN TRANSACTION;

-- -----------------------------------------------------------------------------
-- 1. church_memory — add missing TODO §7a columns
--    SQLite does not support adding multiple columns in one ALTER TABLE;
--    each column must be a separate statement.
--    Columns already present: id, place_id, name, jurisdiction, address, city,
--    state, country, lat, lng, phone, website, liturgical_calendar, source,
--    last_verified, created_at, updated_at
-- -----------------------------------------------------------------------------

-- Google Maps URL
ALTER TABLE church_memory ADD COLUMN google_maps_url TEXT;

-- Rating data (from Google Places)
ALTER TABLE church_memory ADD COLUMN rating REAL;
ALTER TABLE church_memory ADD COLUMN rating_count INTEGER;

-- Canonical status (from Assembly of Bishops)
-- 1 = confirmed canonical, 0 = confirmed non-canonical, NULL = unknown
ALTER TABLE church_memory ADD COLUMN canonical INTEGER;

-- Service schedule (human-curated JSON: [{day, time, type}])
ALTER TABLE church_memory ADD COLUMN service_schedule_json TEXT;

-- Opening hours (from Google Places JSON)
ALTER TABLE church_memory ADD COLUMN opening_hours_json TEXT;

-- Hours source: google_places | church_memory | assembly_of_bishops
ALTER TABLE church_memory ADD COLUMN hours_source TEXT NOT NULL DEFAULT 'google_places';

-- TTL metadata
ALTER TABLE church_memory ADD COLUMN last_fetched_at TEXT;

-- Zip code (for zip-based cache lookup)
ALTER TABLE church_memory ADD COLUMN zip TEXT;

-- New indexes for the added columns
CREATE INDEX IF NOT EXISTS idx_church_zip ON church_memory(zip);
CREATE INDEX IF NOT EXISTS idx_church_canonical ON church_memory(canonical);
CREATE INDEX IF NOT EXISTS idx_church_last_fetched ON church_memory(last_fetched_at);

-- -----------------------------------------------------------------------------
-- 2. btw_queue — add session-scoped columns for TODO §8e
--    The existing btw_queue is a notification queue (message-based).
--    We ADD the session-scoped columns without removing the old ones,
--    so existing code continues to work.
--    New columns: session_id, btw_id, question, mode, answer, answered, answered_at
-- -----------------------------------------------------------------------------

-- Session-scoped BTW columns (NULL for legacy notification rows)
ALTER TABLE btw_queue ADD COLUMN session_id TEXT;
ALTER TABLE btw_queue ADD COLUMN btw_id TEXT;
ALTER TABLE btw_queue ADD COLUMN question TEXT;
ALTER TABLE btw_queue ADD COLUMN mode TEXT;
ALTER TABLE btw_queue ADD COLUMN answer TEXT;
ALTER TABLE btw_queue ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE btw_queue ADD COLUMN answered_at TEXT;

-- Index for session-scoped lookups
CREATE INDEX IF NOT EXISTS idx_btw_session ON btw_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_btw_answered ON btw_queue(answered);

COMMIT;
