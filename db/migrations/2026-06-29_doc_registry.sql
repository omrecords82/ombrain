-- doc_registry — om-brain documentation index (path truth map, not file store).
-- Applied automatically via schema.sql on fresh init; run manually on existing DBs.

CREATE TABLE IF NOT EXISTS doc_registry (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,
  repo            TEXT NOT NULL,              -- omai | om | omstudio | om-workshop | ops | other
  category        TEXT NOT NULL,              -- platform | operations | om-brain | coordination | archive | agents | other
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'canonical', -- canonical | duplicate | archive | missing | unclassified
  sha256          TEXT,
  mtime           TEXT,                       -- ISO-8601 file mtime
  last_scanned_at TEXT NOT NULL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(path, repo)
);
CREATE INDEX IF NOT EXISTS idx_doc_registry_repo ON doc_registry(repo);
CREATE INDEX IF NOT EXISTS idx_doc_registry_category ON doc_registry(category);
CREATE INDEX IF NOT EXISTS idx_doc_registry_status ON doc_registry(status);
CREATE INDEX IF NOT EXISTS idx_doc_registry_sha256 ON doc_registry(sha256);
