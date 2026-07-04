#!/usr/bin/env node
'use strict';

/**
 * One-time backfill: resolve target identity for existing host reachability
 * rows in event_memory (host.unreachable / host.recovered) that predate the
 * 2026-07-04_host_target_identity.sql migration.
 *
 * Non-destructive: only fills the NEW target_* columns on rows where they are
 * NULL; payload_json and every legacy column are untouched. event_memory is a
 * rolling window (NOT append-only; the append-only ledger is decision_memory),
 * so an UPDATE limited to new columns respects OM-CONTRACT-0024 conventions.
 *
 * Usage (on the brain host, service may stay running — WAL mode):
 *   sudo -u om-brain node scripts/backfill-host-target-identity.js \
 *     [--db /var/lib/om-brain/brain.db] [--dry-run]
 *
 * ALWAYS take a SQLite backup first:
 *   sudo -u om-brain cp /var/lib/om-brain/brain.db \
 *     /var/lib/om-brain/brain.db.pre-target-identity-$(date -u +%Y%m%dT%H%M%SZ)
 */

const path = require('path');
const { resolveTargetIdentity } = require('../src/ingest/eventIdentity');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : '/var/lib/om-brain/brain.db';

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 is required for the backfill:', e.message);
  process.exit(1);
}

const db = new Database(path.resolve(dbPath));
db.pragma('journal_mode = WAL');

const cols = db.prepare("PRAGMA table_info(event_memory)").all().map((c) => c.name);
if (!cols.includes('target_ip')) {
  console.error('event_memory has no target_ip column — run the 2026-07-04_host_target_identity.sql migration first.');
  process.exit(1);
}

const select = db.prepare(`
  SELECT id, event_type, payload_json
  FROM event_memory
  WHERE event_type IN ('host.unreachable', 'host.recovered')
    AND target_ip IS NULL AND target_identity_status IS NULL
`);

const update = db.prepare(`
  UPDATE event_memory
  SET target_name = ?, target_ip = ?, target_host = ?, target_service = ?,
      check_method = ?, checked_from = ?, target_identity_status = ?
  WHERE id = ?
`);

let scanned = 0;
let resolved = 0;
let malformed = 0;

const rows = select.all();
const apply = db.transaction((batch) => {
  for (const row of batch) {
    scanned += 1;
    let payload = null;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (_) {
      payload = null;
    }
    const identity = resolveTargetIdentity(row.event_type, payload || {});
    if (identity.target_identity_status === 'malformed') malformed += 1;
    else if (identity.target_identity_status) resolved += 1;
    if (!dryRun) {
      update.run(
        identity.target_name,
        identity.target_ip,
        identity.target_host,
        identity.target_service,
        identity.check_method,
        identity.checked_from,
        identity.target_identity_status,
        row.id,
      );
    }
  }
});
apply(rows);

console.log(JSON.stringify({ db: dbPath, dry_run: dryRun, scanned, resolved, malformed }, null, 2));
