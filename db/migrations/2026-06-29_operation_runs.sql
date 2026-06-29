-- operation_registry + operation_runs — om-brain built-in ops catalog and run history.
-- Applied automatically via schema.sql on fresh init; run manually on existing DBs.

CREATE TABLE IF NOT EXISTS operation_registry (
  id              TEXT PRIMARY KEY,           -- e.g. doc-registry-scan
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  handler_ref     TEXT NOT NULL,              -- module handler key
  script_ref      TEXT,                       -- optional CLI script path
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operation_runs (
  id              TEXT PRIMARY KEY,           -- UUID run id
  operation_id    TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  triggered_by    TEXT NOT NULL DEFAULT 'api',     -- operator | api | schedule | ask
  params_json     TEXT,                       -- commit, dry_run, etc.
  started_at      TEXT,
  finished_at     TEXT,
  exit_code       INTEGER,
  output_summary  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (operation_id) REFERENCES operation_registry(id)
);
CREATE INDEX IF NOT EXISTS idx_operation_runs_op ON operation_runs(operation_id);
CREATE INDEX IF NOT EXISTS idx_operation_runs_status ON operation_runs(status);
CREATE INDEX IF NOT EXISTS idx_operation_runs_started ON operation_runs(started_at);
