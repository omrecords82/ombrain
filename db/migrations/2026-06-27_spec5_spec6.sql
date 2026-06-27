-- =============================================================================
-- Migration: 2026-06-27_spec5_spec6.sql
-- Adds spec §5 columns to correction_memory and spec §6 columns to
-- theological_memory. Both tables already exist; this migration is additive
-- and safe to run on an existing database.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- §5 — correction_memory: add spec-required columns
-- (existing columns decision_id / correction_type / wrong_answer / correct_answer
--  / submitted_by remain in place for backward compatibility)
-- -----------------------------------------------------------------------------

-- source_decision_id: explicit FK alias matching spec field name
ALTER TABLE correction_memory ADD COLUMN source_decision_id TEXT;

-- session_id: which diagnostic session produced the wrong answer
ALTER TABLE correction_memory ADD COLUMN session_id TEXT;

-- question_type: classifier bucket for stumble-threshold grouping
-- values: service_restart_recommendation | cross_tenant_detection |
--         schema_change_governance | never_auto_action | informational | other
ALTER TABLE correction_memory ADD COLUMN question_type TEXT;

-- verdict: how wrong was it?
-- values: incorrect | partially_correct | overconfident | stuck
ALTER TABLE correction_memory ADD COLUMN verdict TEXT;

-- original_output: verbatim Brain output that was wrong (alias for wrong_answer)
ALTER TABLE correction_memory ADD COLUMN original_output TEXT;

-- correction: the correct answer (alias for correct_answer)
ALTER TABLE correction_memory ADD COLUMN correction TEXT;

-- correction_source: who/what generated the correction
-- values: operator_override | auto_loop_detect | auto_stumble_detect
ALTER TABLE correction_memory ADD COLUMN correction_source TEXT;

-- correction_version: incremented on each revise; 1 = original
ALTER TABLE correction_memory ADD COLUMN correction_version INTEGER NOT NULL DEFAULT 1;

-- active: 0 = superseded by a newer revision of the same correction
ALTER TABLE correction_memory ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- Indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_correction_question_type ON correction_memory(question_type);
CREATE INDEX IF NOT EXISTS idx_correction_active ON correction_memory(active);
CREATE INDEX IF NOT EXISTS idx_correction_session ON correction_memory(session_id);

-- -----------------------------------------------------------------------------
-- §6 — theological_memory: add spec-required columns
-- (existing columns category / subcategory / reference_key / title / body /
--  source / language / embedding remain in place)
-- -----------------------------------------------------------------------------

-- source_ref: spec-required alias for the source citation string
ALTER TABLE theological_memory ADD COLUMN source_ref TEXT;

-- book: scripture book name (e.g. "Genesis", "John")
ALTER TABLE theological_memory ADD COLUMN book TEXT;

-- chapter: scripture chapter number
ALTER TABLE theological_memory ADD COLUMN chapter INTEGER;

-- verse_start / verse_end: verse range
ALTER TABLE theological_memory ADD COLUMN verse_start INTEGER;
ALTER TABLE theological_memory ADD COLUMN verse_end INTEGER;

-- topic_tags: comma-separated or JSON topic tags for theologyByTopic()
ALTER TABLE theological_memory ADD COLUMN topic_tags TEXT;

-- Indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_theo_book_chapter ON theological_memory(book, chapter);
CREATE INDEX IF NOT EXISTS idx_theo_topic_tags ON theological_memory(topic_tags);
