#!/usr/bin/env node
'use strict';

/**
 * Operator hygiene: close open Nagios-derived work_memory incidents whose
 * Nagios objects were renamed or removed (no SoT recovery transition will
 * ever arrive for the old object key).
 *
 * Does NOT invent recovery for live problems. Only closes sessions listed in
 * --close or matching built-in rename/removal rules when --apply-defaults.
 *
 * Usage (brain host; WAL-safe; prefer dry-run first):
 *   sudo -u om-brain node scripts/reconcile-stale-nagios-incidents.js --dry-run
 *   sudo -u om-brain node scripts/reconcile-stale-nagios-incidents.js --apply-defaults
 *
 * ALWAYS take a SQLite backup first:
 *   sudo -u om-brain cp /var/lib/om-brain/brain.db \
 *     /var/lib/om-brain/brain.db.pre-incident-hygiene-$(date -u +%Y%m%dT%H%M%SZ)
 */

const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--apply-defaults');
const applyDefaults = args.includes('--apply-defaults');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : '/var/lib/om-brain/brain.db';

/**
 * Default stale closures after host rename + Samba correction (2026-08-04).
 * Keep real problems on renamed hosts (operator / omstudio-dev / omevaluator)
 * and Swap WARNING.
 */
const DEFAULT_CLOSURES = [
  {
    work_item_ref: 'host:host-192-168-1-101',
    reason: 'nagios_object_renamed_superseded',
    superseded_by: 'host:operator',
    detail: 'Nagios host renamed to inventory name operator (192.168.1.101); open incident retained on host:operator',
  },
  {
    work_item_ref: 'host:host-192-168-1-240',
    reason: 'nagios_object_renamed_superseded',
    superseded_by: 'host:omstudio-dev',
    detail: 'Nagios host renamed to inventory name omstudio-dev (192.168.1.240); open incident retained on host:omstudio-dev',
  },
  {
    work_item_ref: 'host:host-192-168-1-249',
    reason: 'nagios_object_renamed_superseded',
    superseded_by: 'host:omevaluator',
    detail: 'Nagios host renamed to inventory name omevaluator (192.168.1.249); open incident retained on host:omevaluator',
  },
  {
    work_item_ref: 'service:om-sh1::NFS TCP 2049',
    reason: 'nagios_object_removed',
    superseded_by: 'service:om-sh1::Samba TCP 445',
    detail: 'NFS TCP 2049 check removed; om-sh1 is Samba/CIFS (TCP 445/139). No NFS service remains in Nagios.',
  },
];

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 is required:', e.message);
  process.exit(1);
}

const db = new Database(path.resolve(dbPath));
db.pragma('journal_mode = WAL');

const selectOpen = db.prepare(`
  SELECT session_id, work_item_ref, incident_tier, state, context_json, opened_at, updated_at
  FROM work_memory
  WHERE session_id LIKE 'nagios:%'
    AND state NOT IN ('closed', 'resolved')
  ORDER BY updated_at DESC
`);

const update = db.prepare(`
  UPDATE work_memory
  SET state = 'closed',
      context_json = ?,
      updated_at = datetime('now')
  WHERE session_id = ?
    AND state NOT IN ('closed', 'resolved')
`);

const openRows = selectOpen.all();
const byRef = new Map(openRows.map((r) => [r.work_item_ref, r]));

const planned = DEFAULT_CLOSURES;
const closed = [];
const skipped = [];
const leftOpen = openRows
  .filter((r) => !planned.some((p) => p.work_item_ref === r.work_item_ref))
  .map((r) => ({
    work_item_ref: r.work_item_ref,
    state: r.state,
    incident_tier: r.incident_tier,
    opened_at: r.opened_at,
    updated_at: r.updated_at,
  }));

const apply = db.transaction(() => {
  for (const item of planned) {
    const row = byRef.get(item.work_item_ref);
    if (!row) {
      skipped.push({ work_item_ref: item.work_item_ref, reason: 'not_open_or_missing' });
      continue;
    }
    let ctx = {};
    try {
      ctx = JSON.parse(row.context_json || '{}') || {};
    } catch (_) {
      ctx = {};
    }
    const nextCtx = {
      ...ctx,
      recovered_verified: false,
      operator_reconciled: true,
      close_reason: item.reason,
      close_detail: item.detail,
      superseded_by: item.superseded_by || null,
      closed_at: new Date().toISOString(),
      closed_by: 'reconcile-stale-nagios-incidents.js',
      last_event_type: ctx.last_event_type || null,
    };
    if (!dryRun) {
      update.run(JSON.stringify(nextCtx), row.session_id);
    }
    closed.push({
      session_id: row.session_id,
      work_item_ref: item.work_item_ref,
      reason: item.reason,
      superseded_by: item.superseded_by || null,
      prior_state: row.state,
    });
  }
});

apply();

const summary = {
  db: dbPath,
  dry_run: dryRun,
  apply_defaults: applyDefaults,
  closed_count: closed.length,
  skipped_count: skipped.length,
  left_open_count: leftOpen.length,
  closed,
  skipped,
  left_open: leftOpen,
};

console.log(JSON.stringify(summary, null, 2));
db.close();

if (dryRun && !applyDefaults) {
  console.error('\nDry-run only. Re-run with --apply-defaults to write closures.');
}
