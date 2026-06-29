-- Fleet operations: spawn_mode on registry + per-host child runs.
-- Applied automatically via schema.sql on fresh init; run manually on existing DBs.

ALTER TABLE operation_registry ADD COLUMN spawn_mode TEXT NOT NULL DEFAULT 'local';
ALTER TABLE operation_registry ADD COLUMN transport TEXT;

CREATE TABLE IF NOT EXISTS operation_run_children (
  id              TEXT PRIMARY KEY,
  parent_run_id   TEXT NOT NULL,
  host            TEXT NOT NULL,
  hostname        TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  exit_code       INTEGER,
  result_json     TEXT,
  transport       TEXT NOT NULL DEFAULT 'ssh',
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_run_id) REFERENCES operation_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_operation_run_children_parent ON operation_run_children(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_operation_run_children_host ON operation_run_children(host);
