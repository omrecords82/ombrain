'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryDB } = require('../src/memory/db');
const { OmstudioClient } = require('../src/governance/omstudioClient');
const { GovernanceManager } = require('../src/governance/governanceManager');
const { Orchestrator } = require('../src/orchestrator/orchestrator');

function freshStack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omgov-'));
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const omstudio = new OmstudioClient({ transport: 'dryrun', outboxDir: path.join(root, 'outbox') });
  const governance = new GovernanceManager({ db, omstudio });
  const orchestrator = new Orchestrator({ db, aiClient: null, governance });
  return { root, db, omstudio, governance, orchestrator };
}

test('human-only proposal creates + submits an approval request, executed:false', async () => {
  const { orchestrator, db } = freshStack();
  const out = await orchestrator.diagnose({
    incident: { summary: 'add nginx route' },
    proposal: { description: 'add nginx location proxy_pass to 7060' },
  });
  assert.equal(out.governance.classification, 'requires_human_superadmin');
  assert.equal(out.executed, false);
  assert.equal(out.requires_human_superadmin_approval, true);
  assert.ok(out.omstudio);
  assert.equal(out.omstudio.requires_human_superadmin_approval, true);
  assert.equal(out.omstudio.status, 'SUBMITTED');
  assert.ok(out.omstudio.omstudio_approval_ref, 'should have an outbox ref');

  const approvals = db.listApprovalRequests(10);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].state, 'SUBMITTED');

  // audit mirror: at least the audit event + the approval-request record
  const audit = db.listOmstudioAudit(10);
  assert.ok(audit.length >= 2);
});

test('auto-safe action is audited but creates NO approval request', async () => {
  const { orchestrator, db } = freshStack();
  const out = await orchestrator.diagnose({
    incident: { summary: 'omai 502' },
    proposal: { action: 'service_restart', target: 'omai' },
  });
  assert.equal(out.governance.classification, 'auto_safe_recommendation');
  assert.equal(out.executed, false);
  assert.equal(out.requires_human_superadmin_approval, false);

  const approvals = db.listApprovalRequests(10);
  assert.equal(approvals.length, 0, 'auto-safe must NOT open an approval request');

  const audit = db.listOmstudioAudit(10);
  assert.equal(audit.length, 1, 'auto-safe still audited');
  assert.equal(audit[0].kind, 'audit_event');
});

test('observability audit records platform health improvement without approval', async () => {
  const { governance, db } = freshStack();
  const emit = await governance.emitObservabilityAudit({
    kind: 'platform_health_improved',
    title: 'Platform health improved',
    message: 'Fleet health rose from 60% to 75%.',
    payload: { from_score: 60, to_score: 75 },
  });
  assert.equal(emit.ok, true);
  const audit = db.listOmstudioAudit(10);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].kind, 'observability_event');
});

test('Tier 0 cross-tenant case escalates and creates an approval request', async () => {
  const { orchestrator, db } = freshStack();
  const out = await orchestrator.diagnose({
    incident: { summary: 'parish A sees parish B' },
    context: { sessionChurchId: 46, accessedChurchId: 278 },
  });
  assert.equal(out.governance.classification, 'tier0_halt_escalate');
  assert.equal(out.executed, false);
  assert.equal(out.requires_human_superadmin_approval, true);
  const approvals = db.listApprovalRequests(10);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].classification, 'tier0_halt_escalate');
});

test('ingest-status applies a simulated OMStudio APPROVED decision', async () => {
  const { orchestrator, governance, db } = freshStack();
  const out = await orchestrator.diagnose({
    incident: { summary: 'billing change' },
    proposal: { description: 'change stripe billing plan permissions' },
  });
  const approvalId = out.omstudio.approval_id;
  assert.ok(approvalId);

  const r = governance.ingestStatus(approvalId, { decision: 'approved', source: 'dryrun_sim' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'SUBMITTED');
  assert.equal(r.to, 'APPROVED');

  const row = db.getApprovalRequest(approvalId);
  assert.equal(row.state, 'APPROVED');

  // history is append-only: create + submit + approve = 3 rows
  const hist = db.approvalHistory(approvalId);
  assert.equal(hist.length, 3);
  assert.equal(hist[0].to_state, 'PENDING_SUBMISSION');
  assert.equal(hist[1].to_state, 'SUBMITTED');
  assert.equal(hist[2].to_state, 'APPROVED');
  assert.equal(hist[2].source, 'dryrun_sim');
});

test('Brain cannot self-approve via ingestStatus with a brain source', async () => {
  const { orchestrator, governance, db } = freshStack();
  const out = await orchestrator.diagnose({
    incident: { summary: 'permissions change' },
    proposal: { description: 'modify rbac permissions matrix' },
  });
  const approvalId = out.omstudio.approval_id;

  // Attempt to drive APPROVED with a Brain-owned source is rejected by the SM.
  const sm = require('../src/governance/approvalStateMachine');
  const bad = sm.canTransition('SUBMITTED', 'APPROVED', sm.SOURCES.BRAIN_SUBMIT);
  assert.equal(bad.ok, false);

  // The state stays SUBMITTED.
  const row = db.getApprovalRequest(approvalId);
  assert.equal(row.state, 'SUBMITTED');
});

test('invalid ingest transition is rejected (cannot approve a PENDING request without submit)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omgov2-'));
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const omstudio = new OmstudioClient({ transport: 'dryrun', outboxDir: path.join(root, 'outbox') });
  const governance = new GovernanceManager({ db, omstudio });
  // Manually create a PENDING_SUBMISSION approval (not yet submitted).
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'PENDING_SUBMISSION',
  });
  const r = governance.ingestStatus(id, { decision: 'approved', source: 'omstudio_ingest' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /transition_not_allowed/);
});
