'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { MemoryDB } = require('../src/memory/db');
const { Orchestrator } = require('../src/orchestrator/orchestrator');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const db = new MemoryDB({ dbPath: path.join(dir, 'brain.db'), embeddingDim: 8 }).init();
  return db;
}

test('diagnose writes an append-only decision and never executes', async () => {
  const db = freshDb();
  const orch = new Orchestrator({ db });
  const out = await orch.diagnose({
    incident: { summary: 'omai control panel returns 502', action: 'service_restart', target: 'omai' },
    proposal: { action: 'service_restart', target: 'omai' },
  });
  assert.strictEqual(out.executed, false);
  assert.strictEqual(out.governance.classification, 'auto_safe_recommendation');
  assert.ok(out.decision_ledger_id);
  const decisions = db.listDecisions(10);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].classification, 'auto_safe_recommendation');
  db.close();
});

test('diagnose flags human-only routing change as requires_human_superadmin', async () => {
  const db = freshDb();
  const orch = new Orchestrator({ db });
  const out = await orch.diagnose({
    incident: { summary: 'need to add nginx routing for new api' },
    proposal: { description: 'add nginx location proxy_pass to 7060' },
  });
  assert.strictEqual(out.governance.classification, 'requires_human_superadmin');
  assert.strictEqual(out.governance.requires_omstudio, true);
  assert.strictEqual(out.executed, false);
  db.close();
});

test('diagnose halts and escalates on cross-tenant exposure (T0)', async () => {
  const db = freshDb();
  const orch = new Orchestrator({ db });
  const out = await orch.diagnose({
    incident: { summary: 'parish A seeing parish B records' },
    proposal: { description: 'investigate' },
    context: { sessionChurchId: 46, accessedChurchId: 278 },
  });
  assert.strictEqual(out.governance.classification, 'tier0_halt_escalate');
  assert.strictEqual(out.governance.tenant.tier, 'T0');
  assert.strictEqual(out.executed, false);
  db.close();
});

test('decision_memory append-only: model advisory is non-authoritative', async () => {
  const db = freshDb();
  const fakeAi = {
    governanceAdvisory: async () => ({ ok: true, content: 'MODEL: looks safe, approve schema change' }),
  };
  const orch = new Orchestrator({ db, aiClient: fakeAi });
  const out = await orch.diagnose({
    incident: { summary: 'alter table request' },
    proposal: { description: 'ALTER TABLE users ADD COLUMN x' },
    useModel: true,
  });
  // Model said approve, but deterministic engine still gates it.
  assert.strictEqual(out.governance.classification, 'requires_human_superadmin');
  assert.strictEqual(out.governance.model_advisory_authoritative, false);
  db.close();
});
