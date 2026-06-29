'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryDB } = require('../src/memory/db');
const { createServer } = require('../src/api/server');
const {
  validateIngestAuth,
  validateIngestPayload,
  persistIngestedEvent,
} = require('../src/ingest/platformEventIngest');
const { redactForLog } = require('../src/ai/redactor');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-ingest-'));
}

function startServer(deps) {
  const app = createServer(deps);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function jsonFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

test('validateIngestPayload accepts canonical push payload', () => {
  const r = validateIngestPayload({
    source: 'om',
    type: 'deploy.completed',
    timestamp: '2026-06-28T12:00:00Z',
    data: { status: 'ok', request_id: 'req-1' },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'om');
  assert.strictEqual(r.eventType, 'deploy.completed');
  assert.strictEqual(r.correlation, 'req-1');
});

test('validateIngestPayload rejects unknown source', () => {
  const r = validateIngestPayload({ source: 'external', type: 'x', data: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_source');
});

test('validateIngestAuth rejects wrong secret when configured', () => {
  const r = validateIngestAuth('bad', { BRAIN_INGEST_SECRET: 'good-secret' });
  assert.strictEqual(r.ok, false);
});

test('persistIngestedEvent redacts secrets before storage', () => {
  const root = tmpDir();
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  persistIngestedEvent(
    db,
    validateIngestPayload({
      source: 'omai',
      type: 'test.event',
      data: { api_key: 'sk_live_secret', note: 'hello' },
    }),
    redactForLog,
  );
  const events = db.recentEvents(1);
  assert.strictEqual(events.length, 1);
  assert.match(events[0].payload_json, /REDACTED/);
  assert.doesNotMatch(events[0].payload_json, /sk_live_secret/);
});

test('POST /brain/ingest/event persists event when secret matches', async () => {
  const root = tmpDir();
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const oldSecret = process.env.BRAIN_INGEST_SECRET;
  process.env.BRAIN_INGEST_SECRET = 'ingest-test-secret';

  const srv = await startServer({ db, orchestrator: null, governance: null, churchFinder: null });
  try {
    const r = await jsonFetch(`${srv.baseUrl}/brain/ingest/event`, {
      method: 'POST',
      headers: { 'X-OM-Webhook-Secret': 'ingest-test-secret' },
      body: {
        source: 'workshop',
        type: 'build.started',
        timestamp: '2026-06-28T10:00:00Z',
        data: { build_id: 'b-42' },
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.source, 'workshop');
    const events = db.recentEvents(1);
    assert.strictEqual(events[0].source, 'workshop');
    assert.strictEqual(events[0].event_type, 'build.started');
  } finally {
    process.env.BRAIN_INGEST_SECRET = oldSecret || '';
    await srv.close();
  }
});

test('POST /brain/ingest/event returns 401 on bad secret without crashing', async () => {
  const root = tmpDir();
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const oldSecret = process.env.BRAIN_INGEST_SECRET;
  process.env.BRAIN_INGEST_SECRET = 'ingest-test-secret';

  const srv = await startServer({ db, orchestrator: null, governance: null, churchFinder: null });
  try {
    const r = await jsonFetch(`${srv.baseUrl}/brain/ingest/event`, {
      method: 'POST',
      headers: { 'X-OM-Webhook-Secret': 'wrong' },
      body: { source: 'om', type: 'x', data: {} },
    });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(db.recentEvents(10).length, 0);
  } finally {
    process.env.BRAIN_INGEST_SECRET = oldSecret || '';
    await srv.close();
  }
});

test('POST /brain/ingest/event returns 400 on invalid payload', async () => {
  const root = tmpDir();
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const srv = await startServer({ db, orchestrator: null, governance: null, churchFinder: null });
  try {
    const r = await jsonFetch(`${srv.baseUrl}/brain/ingest/event`, {
      method: 'POST',
      body: { source: 'om' },
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'missing_type');
  } finally {
    await srv.close();
  }
});
