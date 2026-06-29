'use strict';

/**
 * Workshop runtime probe + workshop.status@v1 operation.
 * Run: cd om-brain && npm test -- test/workshop-runtime.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { probeWorkshopStatus, createWorkshopClient } = require('../src/adapters/workshopRuntime');
const { runOperation } = require('../src/operations/runner');
const { MemoryDB } = require('../src/memory/db');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ws-'));
  const dbPath = path.join(dir, 'brain.db');
  const db = new MemoryDB({ dbPath, embeddingDim: 8 }).init();
  return { db, dir };
}

test('probeWorkshopStatus logs run_id and target in dryrun', async () => {
  const client = createWorkshopClient({
    baseUrl: 'http://192.168.1.251:7071',
    transport: 'dryrun',
    production: false,
  });
  const probe = await probeWorkshopStatus(client, { run_id: 'test-run-001' });
  assert.strictEqual(probe.run_id, 'test-run-001');
  assert.strictEqual(probe.target, '192.168.1.251:7071');
  assert.strictEqual(probe.ok, true);
  assert.strictEqual(probe.transport, 'dryrun');
  assert.ok(probe.summary);
});

test('workshop.status@v1 operation persists operation_runs row', async () => {
  const { db, dir } = tempDb();
  try {
    const out = await runOperation(db, 'workshop.status@v1', {
      triggered_by: 'test',
      commit: true,
    });
    assert.strictEqual(out.operation_id, 'workshop.status@v1');
    assert.ok(out.run_id);
    assert.ok(out.output_summary.includes('192.168.1.251'));
    const runs = db.listOperationRuns({ operation_id: 'workshop.status@v1', limit: 5 });
    assert.ok(runs.length >= 1);
    assert.strictEqual(runs[0].id, out.run_id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
