#!/usr/bin/env node
'use strict';

/**
 * Controlled Nagios transition fixture against a MemoryDb (default: in-memory)
 * or the live brain.db when --apply is passed.
 *
 * Does not touch the real Nagios daemon. Safe by default (dry-run memory only).
 *
 * Usage:
 *   node scripts/nagios-controlled-transition.js
 *   node scripts/nagios-controlled-transition.js --apply
 */

const path = require('path');
const { NagiosAdapter, HOST, SVC } = require('../src/adapters/nagiosAdapter');
const { sessionIdFor } = require('../src/ingest/nagiosIncidentCorrelator');

const APPLY = process.argv.includes('--apply');

function memoryDb() {
  const events = [];
  const work = new Map();
  let seq = 0;
  return {
    events,
    work,
    insertEvent(row) {
      const id = ++seq;
      events.push({ id, ...row, observed_at: new Date().toISOString() });
      return { id };
    },
    hasRecentEventFingerprint({ source, correlation, event_type, fingerprint }) {
      return events.some((e) => {
        if (e.source !== source || e.correlation !== correlation || e.event_type !== event_type) {
          return false;
        }
        try {
          return JSON.parse(e.payload_json).idempotency_key === fingerprint;
        } catch (_) {
          return false;
        }
      });
    },
    upsertWorkSession(row) {
      work.set(row.session_id, { ...(work.get(row.session_id) || {}), ...row });
    },
    getWorkSession(session_id) {
      return work.get(session_id) || null;
    },
  };
}

function liveDb() {
  const { MemoryDB } = require('../src/memory/db');
  const dbPath = process.env.BRAIN_DB_PATH || '/var/lib/om-brain/brain.db';
  return new MemoryDB({ dbPath }).init();
}

async function main() {
  const db = APPLY ? liveDb() : memoryDb();
  const adapter = new NagiosAdapter({ db });
  const host = 'host-192-168-1-254';
  const svc = 'OMBrain-Fixture';

  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.OK, plugin_output: 'fixture ok', last_check: Date.now() } },
  });
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.CRITICAL, plugin_output: 'fixture critical', last_check: Date.now() } },
  });
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.CRITICAL, plugin_output: 'fixture critical again', last_check: Date.now() } },
  });
  // Force duplicate transition attempt
  adapter.prevServices = {
    [`${host}::${svc}`]: { bucket: 'ok', status: SVC.OK, output: 'ok' },
  };
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.CRITICAL, plugin_output: 'dup', last_check: Date.now() } },
  });
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.OK, plugin_output: 'fixture recovered', last_check: Date.now() } },
  });

  const sid = sessionIdFor(`service:${host}::${svc}`);
  const incident = db.getWorkSession(sid);
  const events = db.events || db.recentEvents?.(20) || [];
  const nagiosEvents = Array.isArray(events)
    ? events.filter((e) => e.source === 'nagios' && String(e.correlation || '').includes('OMBrain-Fixture'))
    : [];

  const summary = {
    apply: APPLY,
    events_total: nagiosEvents.length || (db.events ? db.events.length : null),
    incident_state: incident && incident.state,
    recovered_verified: incident ? JSON.parse(incident.context_json).recovered_verified : null,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (APPLY && typeof db.close === 'function') db.close();
  if (!incident || incident.state !== 'closed') process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
