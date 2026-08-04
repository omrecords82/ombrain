'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  NagiosAdapter,
  hostBucket,
  serviceBucket,
  hostIpFromName,
  HOST,
  SVC,
} = require('../src/adapters/nagiosAdapter');
const { correlateNagiosEvent, sessionIdFor } = require('../src/ingest/nagiosIncidentCorrelator');

test('hostIpFromName parses Nagios host objects', () => {
  assert.equal(hostIpFromName('host-192-168-1-254'), '192.168.1.254');
  assert.equal(hostIpFromName('localhost'), null);
});

test('hostBucket maps statusjson bitmasks', () => {
  assert.equal(hostBucket(HOST.UP), 'up');
  assert.equal(hostBucket(HOST.DOWN), 'down');
  assert.equal(hostBucket(HOST.UNREACHABLE), 'down');
  assert.equal(hostBucket(HOST.PENDING), 'pending');
});

test('serviceBucket maps statusjson bitmasks', () => {
  assert.equal(serviceBucket(SVC.OK), 'ok');
  assert.equal(serviceBucket(SVC.WARNING), 'warning');
  assert.equal(serviceBucket(SVC.CRITICAL), 'critical');
  assert.equal(serviceBucket(SVC.UNKNOWN), 'unknown');
});

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
      const prev = work.get(row.session_id) || {};
      work.set(row.session_id, { ...prev, ...row });
    },
    getWorkSession(session_id) {
      return work.get(session_id) || null;
    },
  };
}

test('baseline poll does not emit; transition creates one event and one incident', () => {
  const db = memoryDb();
  const adapter = new NagiosAdapter({ db });
  const host = 'host-192-168-1-240';

  adapter.applyHostlist({
    [host]: { status: HOST.UP, plugin_output: 'PING OK', last_check: Date.now() },
  });
  assert.equal(db.events.length, 0);

  const emitted = adapter.applyHostlist({
    [host]: { status: HOST.DOWN, plugin_output: 'CRITICAL', last_check: Date.now() },
  });
  assert.equal(emitted.length, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, 'host.unreachable');
  assert.equal(db.events[0].source, 'nagios');

  const payload = JSON.parse(db.events[0].payload_json);
  assert.equal(payload.source_system, 'nagios');
  assert.equal(payload.previous_state, 'up');
  assert.equal(payload.current_state, 'down');
  assert.ok(payload.idempotency_key);
  assert.ok(payload.normalized_resource_identity);

  const session = db.getWorkSession(sessionIdFor(`host:${host}`));
  assert.ok(session);
  assert.equal(session.state, 'open');
});

test('repeated identical transition is idempotent (no duplicate event/incident)', () => {
  const db = memoryDb();
  const adapter = new NagiosAdapter({ db });
  const host = 'host-192-168-1-101';

  adapter.applyHostlist({ [host]: { status: HOST.UP, plugin_output: 'ok' } });
  adapter.applyHostlist({ [host]: { status: HOST.DOWN, plugin_output: 'down' } });
  assert.equal(db.events.length, 1);

  // Force re-emit attempt with same from→to by resetting prev then replaying.
  adapter.prevHosts = {
    [host]: { bucket: 'up', status: HOST.UP, output: 'ok', ip: '192.168.1.101' },
  };
  const emitted = adapter.applyHostlist({
    [host]: { status: HOST.DOWN, plugin_output: 'down again' },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].result.inserted, false);
  assert.equal(db.events.length, 1);

  const session = db.getWorkSession(sessionIdFor(`host:${host}`));
  assert.equal(session.state, 'open');
});

test('critical service then recovery updates same incident and closes only after verified recovery', () => {
  const db = memoryDb();
  const adapter = new NagiosAdapter({ db });
  const host = 'host-192-168-1-239';
  const svc = 'OM API Health';
  const key = `${host}::${svc}`;

  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.OK, plugin_output: 'HTTP OK' } },
  });
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.CRITICAL, plugin_output: 'HTTP CRITICAL' } },
  });
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, 'service.unhealthy');

  const sid = sessionIdFor(`service:${key}`);
  assert.equal(db.getWorkSession(sid).state, 'open');

  // Repeated critical hard-state: no new incident, and no new event when same transition key.
  adapter.prevServices = {
    [key]: { bucket: 'ok', status: SVC.OK, output: 'HTTP OK' },
  };
  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.CRITICAL, plugin_output: 'still critical' } },
  });
  assert.equal(db.events.length, 1);
  assert.equal(db.getWorkSession(sid).state, 'open');

  adapter.applyServicelist({
    [host]: { [svc]: { status: SVC.OK, plugin_output: 'HTTP OK recovered' } },
  });
  assert.equal(db.events.length, 2);
  assert.equal(db.events[1].event_type, 'service.recovered');
  const closed = db.getWorkSession(sid);
  assert.equal(closed.state, 'closed');
  const ctx = JSON.parse(closed.context_json);
  assert.equal(ctx.recovered_verified, true);
});

test('PING service flaps are ignored (host events cover reachability)', () => {
  const db = memoryDb();
  const adapter = new NagiosAdapter({ db });
  const host = 'host-192-168-1-254';
  adapter.applyServicelist({
    [host]: { PING: { status: SVC.OK, plugin_output: 'ok' } },
  });
  adapter.applyServicelist({
    [host]: { PING: { status: SVC.CRITICAL, plugin_output: 'crit' } },
  });
  assert.equal(db.events.length, 0);
});

test('correlateNagiosEvent does not resolve without verified recovery', () => {
  const db = memoryDb();
  const object = 'service:host-x::API';
  correlateNagiosEvent(db, {
    event_type: 'service.unhealthy',
    severity: 'critical',
    nagios_object: object,
    payload: { nagios_object: object },
  });
  assert.equal(db.getWorkSession(sessionIdFor(object)).state, 'open');
  // Non-recovery event types do not close.
  const r = correlateNagiosEvent(db, {
    event_type: 'service.unhealthy',
    severity: 'warning',
    nagios_object: object,
    payload: { nagios_object: object },
  });
  assert.equal(r.action, 'updated_open_incident');
  assert.equal(db.getWorkSession(sessionIdFor(object)).state, 'open');
});

test('pollOnce with fixture fetch records monitoring snapshot meta', async () => {
  const adapterStatus = require('../src/health/adapterStatus');
  const db = memoryDb();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const isHost = String(url).includes('query=hostlist');
    const body = isHost
      ? {
          result: { type_code: 0 },
          data: {
            hostlist: {
              'host-192-168-1-254': { status: HOST.UP, plugin_output: 'ok', last_check: Date.now() },
            },
          },
        }
      : {
          result: { type_code: 0 },
          data: {
            servicelist: {
              'host-192-168-1-254': {
                OMBrain: { status: SVC.OK, plugin_output: 'ok', last_check: Date.now() },
                Swap: { status: SVC.WARNING, plugin_output: 'swap warn', last_check: Date.now() },
              },
            },
          },
        };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };

  const adapter = new NagiosAdapter({ db, fetchImpl });
  adapter.cfg = {
    ...adapter.cfg,
    enableNagiosAdapter: true,
    nagiosStatusjsonUrl: 'http://example.test/statusjson.cgi',
    nagiosCheckedFrom: 'ops-nagios',
    nagiosStaleMs: 180000,
  };
  adapterStatus.setEnabled('nagios', true);
  await adapter.pollOnce();
  assert.ok(calls >= 2);
  const snap = adapterStatus.snapshot().nagios;
  assert.equal(snap.state, 'ok');
  assert.equal(snap.meta.hosts_total, 1);
  assert.equal(snap.meta.services_warning, 1);
  assert.equal(snap.meta.freshness, 'fresh');
});
