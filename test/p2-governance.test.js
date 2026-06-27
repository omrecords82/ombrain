'use strict';

/**
 * P2 Governance Integration Test Suite — 25 tests.
 *
 * Tests the full round-trip:
 *   Brain (omstudioClient) → OMStudio (governance package) → Brain (ingest-status)
 *
 * Uses:
 *   - MemoryDB (Brain-side SQLite-in-memory)
 *   - MemoryStore (OMStudio-side in-memory store from the governance package)
 *   - Injectable httpImpl to simulate both outbound Brain→OMStudio calls
 *     AND inbound OMStudio→Brain webhook calls
 *   - No live network connections required
 *
 * Coverage:
 *   A. omstudioClient verified paths + auth (5 tests)
 *   B. Webhook secret validation on ingest-status (4 tests)
 *   C. Full round-trip: Brain submits → OMStudio decides → Brain ingests (6 tests)
 *   D. State machine invariants (4 tests)
 *   E. New endpoints: /governance/health, /governance/approvals/:id/history (3 tests)
 *   F. Governance health check method (3 tests)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Brain-side deps --------------------------------------------------------
const { MemoryDB } = require('../src/memory/db');
const { OmstudioClient, validateWebhookSecret } = require('../src/governance/omstudioClient');
const { GovernanceManager } = require('../src/governance/governanceManager');
const { createServer } = require('../src/api/server');
const { Orchestrator } = require('../src/orchestrator/orchestrator');

// ---- OMStudio-side deps (governance package) --------------------------------
// These paths assume the governance package is installed/linked under packages/.
// In CI, run: cd omai/packages/omstudio-brain-governance && npm install
const OMSGOV_PKG = path.resolve(__dirname, '../../../omai/packages/omstudio-brain-governance');

let MemoryStore, GovernanceService, BrainWebhookClient, createApp, govConfig;
try {
  MemoryStore = require(path.join(OMSGOV_PKG, 'src/db/memoryStore')).MemoryStore;
  GovernanceService = require(path.join(OMSGOV_PKG, 'src/governance/service')).GovernanceService;
  BrainWebhookClient = require(path.join(OMSGOV_PKG, 'src/webhook/brainWebhook')).BrainWebhookClient;
  createApp = require(path.join(OMSGOV_PKG, 'src/app')).createApp;
  govConfig = require(path.join(OMSGOV_PKG, 'src/util/config')).config;
} catch (e) {
  console.warn('[p2-governance.test] OMStudio governance package not found at', OMSGOV_PKG);
  console.warn('[p2-governance.test] Skipping OMStudio-side tests. Run: cd', OMSGOV_PKG, '&& npm install');
}

// ---- Helpers ----------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p2gov-'));
}

function freshBrainStack(opts = {}) {
  const root = tmpDir();
  const db = new MemoryDB({ dbPath: path.join(root, 'brain.db') }).init();
  const omstudio = new OmstudioClient({
    transport: opts.transport || 'dryrun',
    baseUrl: opts.baseUrl || '',
    serviceToken: opts.serviceToken || 'svc-token-test',
    outboxDir: path.join(root, 'outbox'),
    production: opts.production || false,
    httpImpl: opts.httpImpl,
  });
  const governance = new GovernanceManager({ db, omstudio });
  const orchestrator = new Orchestrator({ db, aiClient: null, governance });
  return { root, db, omstudio, governance, orchestrator };
}

// Spin up the Brain HTTP server on a random port and return { server, baseUrl, close }.
function startBrainServer(deps) {
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

// =============================================================================
// A. omstudioClient verified paths + auth
// =============================================================================

test('A1: VERIFIED_PATHS are exported and match the confirmed OMStudio contract', () => {
  const { VERIFIED_PATHS } = require('../src/governance/omstudioClient');
  assert.equal(VERIFIED_PATHS.audit, '/omstudio-embed/api/governance/brain/audit-events');
  assert.equal(VERIFIED_PATHS.approvals, '/omstudio-embed/api/governance/brain/approval-requests');
  assert.equal(VERIFIED_PATHS.approvalStatus, '/omstudio-embed/api/governance/brain/approval-requests/:ref');
  assert.equal(VERIFIED_PATHS.health, '/omstudio-embed/api/governance/brain/health');
});

test('A2: ASSUMED_PATHS is an alias for VERIFIED_PATHS (backward compat)', () => {
  const { VERIFIED_PATHS, ASSUMED_PATHS } = require('../src/governance/omstudioClient');
  assert.strictEqual(ASSUMED_PATHS, VERIFIED_PATHS);
});

test('A3: emitAuditEvent sends Bearer token in Authorization header (never in body)', async () => {
  let capturedHeaders = null;
  let capturedBody = null;
  const { omstudio } = freshBrainStack({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    serviceToken: 'secret-svc-token',
    production: true,
    httpImpl: async (url, opts) => {
      capturedHeaders = opts.headers;
      capturedBody = opts.body;
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'oms-1', ref: 'oms-ref-1' }) };
    },
  });
  const res = await omstudio.emitAuditEvent({ decision_id: 1, classification: 'auto_safe_recommendation' });
  assert.equal(res.ok, true);
  assert.equal(capturedHeaders.Authorization, 'Bearer secret-svc-token');
  assert.ok(!capturedBody.includes('secret-svc-token'), 'token must not appear in body');
});

test('A4: submitApprovalRequest returns ref from OMStudio response (prefers ref over id)', async () => {
  const { omstudio } = freshBrainStack({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    production: true,
    httpImpl: async () => ({
      ok: true, status: 201,
      text: async () => JSON.stringify({ id: 99, ref: 'oms-app-2026-06-27-abc', state: 'SUBMITTED' }),
    }),
  });
  const res = await omstudio.submitApprovalRequest({
    approval_local_id: 55,
    classification: 'requires_human_superadmin',
  });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'oms-app-2026-06-27-abc', 'should prefer string ref over numeric id');
});

test('A5: getApprovalStatus returns history array from polling response', async () => {
  const { omstudio } = freshBrainStack({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    production: true,
    httpImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        ref: 'oms-ref-1',
        state: 'SUBMITTED',
        history: [{ to_state: 'SUBMITTED', source: 'create' }],
      }),
    }),
  });
  const res = await omstudio.getApprovalStatus('oms-ref-1');
  assert.equal(res.ok, true);
  assert.equal(res.state, 'SUBMITTED');
  assert.equal(res.history.length, 1);
  assert.equal(res.history[0].to_state, 'SUBMITTED');
});

// =============================================================================
// B. Webhook secret validation
// =============================================================================

test('B1: validateWebhookSecret passes when no secret is configured', () => {
  const r = validateWebhookSecret('anything', '');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_secret_configured');
});

test('B2: validateWebhookSecret rejects missing header when secret is configured', () => {
  const r = validateWebhookSecret('', 'my-webhook-secret');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_webhook_secret');
});

test('B3: validateWebhookSecret rejects wrong secret (constant-time)', () => {
  const r = validateWebhookSecret('wrong-secret', 'my-webhook-secret');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_webhook_secret');
});

test('B4: ingest-status endpoint returns 401 when webhook secret is wrong', async () => {
  const { db, governance } = freshBrainStack();
  // Manually create an approval in SUBMITTED state.
  const approvalId = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  const { baseUrl, close } = await startBrainServer({ db, governance });
  try {
    // Set the webhook secret in env for this test.
    const oldSecret = process.env.OMSTUDIO_WEBHOOK_SECRET;
    process.env.OMSTUDIO_WEBHOOK_SECRET = 'correct-secret';
    const r = await jsonFetch(`${baseUrl}/governance/approvals/${approvalId}/ingest-status`, {
      method: 'POST',
      headers: { 'X-OM-Webhook-Secret': 'wrong-secret' },
      body: { decision: 'approved', source: 'omstudio_ingest' },
    });
    process.env.OMSTUDIO_WEBHOOK_SECRET = oldSecret || '';
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'invalid_webhook_secret');
  } finally {
    await close();
  }
});

// =============================================================================
// C. Full round-trip: Brain submits → OMStudio decides → Brain ingests
// =============================================================================

// This section requires the OMStudio governance package to be installed.
// Tests are skipped gracefully if the package is not found.

let omstudioServer = null;
let omstudioBaseUrl = null;
let omstudioStore = null;
let webhookCalls = [];

before(async () => {
  if (!MemoryStore || !GovernanceService || !BrainWebhookClient || !createApp) return;

  omstudioStore = new MemoryStore();
  await omstudioStore.init();
  webhookCalls = [];

  // The OMStudio webhook client will call the Brain's ingest-status endpoint.
  // We use a real in-process Brain HTTP server as the webhook target.
  // The Brain server URL is set after it starts (see test C1).
});

after(async () => {
  if (omstudioServer) {
    await new Promise((r) => omstudioServer.close(r));
  }
});

test('C1: full round-trip — Brain submits approval, OMStudio superadmin approves, Brain ingests APPROVED', async () => {
  if (!MemoryStore || !GovernanceService || !BrainWebhookClient || !createApp) {
    console.log('[SKIP] OMStudio governance package not installed');
    return;
  }

  // 1. Start the Brain HTTP server.
  const { db, governance } = freshBrainStack();
  const brainSrv = await startBrainServer({ db, governance });

  try {
    // 2. Start the OMStudio governance server with a webhook client pointing at the Brain.
    const brainWebhookUrl = `${brainSrv.baseUrl}/governance/approvals/:id/ingest-status`;
    const httpImpl = async (url, opts) => {
      webhookCalls.push({ url, body: JSON.parse(opts.body) });
      // Forward the webhook call to the actual Brain server.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body,
      });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    };

    // Override the webhook URL in the governance package config for this test.
    const testConfig = {
      ...govConfig,
      webhook: { ...govConfig.webhook, url: brainWebhookUrl, secret: '', maxRetries: 1, backoffMs: 10, backoffMaxMs: 10 },
    };
    const store = new MemoryStore();
    await store.init();
    const webhook = new BrainWebhookClient({ config: testConfig, store, httpImpl });
    const service = new GovernanceService({ store, webhook });
    const omApp = createApp({ service });
    const omSrv = http.createServer(omApp);
    await new Promise((r) => omSrv.listen(0, '127.0.0.1', r));
    const omBase = `http://127.0.0.1:${omSrv.address().port}`;

    // 3. Brain submits an audit event.
    const auditRes = await jsonFetch(`${omBase}/api/governance/brain/audit-events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-token-test' },
      body: {
        type: 'brain_audit_event',
        emitted_at: new Date().toISOString(),
        decision: { decision_id: 1, classification: 'requires_human_superadmin' },
      },
    });
    // Note: svc-token-test won't match unless OMSTUDIO_SERVICE_TOKEN is set.
    // In this test we verify the round-trip logic, not OMStudio auth.
    // The governance package uses process.env.OMSTUDIO_SERVICE_TOKEN.
    // For a clean test, we set it here.
    process.env.OMSTUDIO_SERVICE_TOKEN = 'svc-token-test';
    process.env.OMSTUDIO_SERVICE_SCOPES = 'write:brain-audit,write:brain-approvals';
    process.env.OMSTUDIO_ADMIN_TOKEN = 'admin-token-test';

    // 4. Brain creates a local approval request (simulating GovernanceManager.processDecision).
    const brainLocalId = db.createApprovalRequest({
      classification: 'requires_human_superadmin',
      proposal_summary: '[requires_human_superadmin] add nginx route',
      state: 'SUBMITTED',
    });
    assert.ok(brainLocalId);

    // 5. Brain submits the approval to OMStudio.
    const approvalRes = await jsonFetch(`${omBase}/api/governance/brain/approval-requests`, {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-token-test' },
      body: {
        type: 'brain_approval_request',
        submitted_at: new Date().toISOString(),
        request: {
          approval_local_id: brainLocalId,
          source_decision_id: 1,
          classification: 'requires_human_superadmin',
          proposal_summary: '[requires_human_superadmin] add nginx route',
        },
      },
    });
    assert.equal(approvalRes.status, 201, `Expected 201, got ${approvalRes.status}: ${JSON.stringify(approvalRes.json)}`);
    assert.equal(approvalRes.json.state, 'SUBMITTED');
    const omstudioRef = approvalRes.json.ref;
    assert.ok(omstudioRef);

    // 6. Superadmin approves in OMStudio UI.
    const decisionRes = await jsonFetch(
      `${omBase}/api/governance/brain/approval-requests/${omstudioRef}/decision`,
      {
        method: 'POST',
        headers: { 'X-OM-Admin-Token': 'admin-token-test' },
        body: { decision: 'APPROVED', actor: 'alice@superadmin', note: 'approved in test' },
      },
    );
    assert.equal(decisionRes.status, 200, `Decision failed: ${JSON.stringify(decisionRes.json)}`);
    assert.equal(decisionRes.json.to, 'APPROVED');
    assert.equal(decisionRes.json.webhook.delivered, true);

    // 7. Verify the webhook was called with the correct payload.
    const call = webhookCalls.at(-1);
    assert.ok(call, 'webhook must have been called');
    assert.match(call.url, new RegExp(`/governance/approvals/${brainLocalId}/ingest-status$`));
    assert.deepEqual(call.body, {
      decision: 'approved',
      source: 'omstudio_ingest',
      omstudio_ref: omstudioRef,
      note: 'approved in test',
    });

    // 8. Verify the Brain's local approval was updated to APPROVED.
    const brainApproval = db.getApprovalRequest(brainLocalId);
    assert.equal(brainApproval.state, 'APPROVED');

    // 9. Verify append-only history: PENDING_SUBMISSION → SUBMITTED → APPROVED.
    const hist = db.approvalHistory(brainLocalId);
    assert.ok(hist.length >= 2, `Expected at least 2 history rows, got ${hist.length}`);
    const toStates = hist.map((h) => h.to_state);
    assert.ok(toStates.includes('SUBMITTED'), 'history must include SUBMITTED');
    assert.ok(toStates.includes('APPROVED'), 'history must include APPROVED');

    await new Promise((r) => omSrv.close(r));
  } finally {
    await brainSrv.close();
  }
});

test('C2: full round-trip — superadmin REJECTS, Brain ingests REJECTED', async () => {
  if (!MemoryStore || !GovernanceService || !BrainWebhookClient || !createApp) return;

  const { db, governance } = freshBrainStack();
  const brainSrv = await startBrainServer({ db, governance });

  try {
    const brainWebhookUrl = `${brainSrv.baseUrl}/governance/approvals/:id/ingest-status`;
    const httpImpl = async (url, opts) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body,
      });
      return { ok: res.ok, status: res.status, text: () => res.text() };
    };
    const testConfig = {
      ...govConfig,
      webhook: { ...govConfig.webhook, url: brainWebhookUrl, secret: '', maxRetries: 1, backoffMs: 10, backoffMaxMs: 10 },
    };
    const store = new MemoryStore();
    await store.init();
    const webhook = new BrainWebhookClient({ config: testConfig, store, httpImpl });
    const service = new GovernanceService({ store, webhook });
    const omApp = createApp({ service });
    const omSrv = http.createServer(omApp);
    await new Promise((r) => omSrv.listen(0, '127.0.0.1', r));
    const omBase = `http://127.0.0.1:${omSrv.address().port}`;

    const brainLocalId = db.createApprovalRequest({
      classification: 'tier0_halt_escalate',
      proposal_summary: 'cross-tenant access',
      state: 'SUBMITTED',
    });

    const approvalRes = await jsonFetch(`${omBase}/api/governance/brain/approval-requests`, {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-token-test' },
      body: {
        request: {
          approval_local_id: brainLocalId,
          classification: 'tier0_halt_escalate',
        },
      },
    });
    const omstudioRef = approvalRes.json.ref;

    const decisionRes = await jsonFetch(
      `${omBase}/api/governance/brain/approval-requests/${omstudioRef}/decision`,
      {
        method: 'POST',
        headers: { 'X-OM-Admin-Token': 'admin-token-test' },
        body: { decision: 'REJECTED', actor: 'bob@superadmin', note: 'cross-tenant rejected' },
      },
    );
    assert.equal(decisionRes.json.to, 'REJECTED');
    assert.equal(decisionRes.json.webhook.delivered, true);

    const brainApproval = db.getApprovalRequest(brainLocalId);
    assert.equal(brainApproval.state, 'REJECTED');

    await new Promise((r) => omSrv.close(r));
  } finally {
    await brainSrv.close();
  }
});

test('C3: Brain service token cannot drive a decision (403)', async () => {
  if (!MemoryStore || !GovernanceService || !createApp) return;

  const store = new MemoryStore();
  await store.init();
  const service = new GovernanceService({ store, webhook: null });
  const omApp = createApp({ service });
  const omSrv = http.createServer(omApp);
  await new Promise((r) => omSrv.listen(0, '127.0.0.1', r));
  const omBase = `http://127.0.0.1:${omSrv.address().port}`;

  // Create an approval first.
  const approvalRes = await jsonFetch(`${omBase}/api/governance/brain/approval-requests`, {
    method: 'POST',
    headers: { Authorization: 'Bearer svc-token-test' },
    body: { request: { approval_local_id: 1, classification: 'requires_human_superadmin' } },
  });
  const ref = approvalRes.json.ref;

  // Attempt to decide using the service token (not superadmin).
  const decisionRes = await jsonFetch(
    `${omBase}/api/governance/brain/approval-requests/${ref}/decision`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer svc-token-test' },
      body: { decision: 'APPROVED' },
    },
  );
  assert.equal(decisionRes.status, 403, 'service token must not be able to decide');

  await new Promise((r) => omSrv.close(r));
});

test('C4: second decision on a terminal approval is rejected (409)', async () => {
  if (!MemoryStore || !GovernanceService || !createApp) return;

  const store = new MemoryStore();
  await store.init();
  const service = new GovernanceService({ store, webhook: null });
  const omApp = createApp({ service });
  const omSrv = http.createServer(omApp);
  await new Promise((r) => omSrv.listen(0, '127.0.0.1', r));
  const omBase = `http://127.0.0.1:${omSrv.address().port}`;

  const approvalRes = await jsonFetch(`${omBase}/api/governance/brain/approval-requests`, {
    method: 'POST',
    headers: { Authorization: 'Bearer svc-token-test' },
    body: { request: { approval_local_id: 2, classification: 'requires_human_superadmin' } },
  });
  const ref = approvalRes.json.ref;

  // First decision — approve.
  await jsonFetch(`${omBase}/api/governance/brain/approval-requests/${ref}/decision`, {
    method: 'POST',
    headers: { 'X-OM-Admin-Token': 'admin-token-test' },
    body: { decision: 'APPROVED' },
  });

  // Second decision — must be rejected.
  const r2 = await jsonFetch(`${omBase}/api/governance/brain/approval-requests/${ref}/decision`, {
    method: 'POST',
    headers: { 'X-OM-Admin-Token': 'admin-token-test' },
    body: { decision: 'REJECTED' },
  });
  assert.equal(r2.status, 409);

  await new Promise((r) => omSrv.close(r));
});

test('C5: Brain direct ingest-status (dryrun_sim) advances state correctly', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  const r = governance.ingestStatus(id, { decision: 'approved', source: 'dryrun_sim' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'SUBMITTED');
  assert.equal(r.to, 'APPROVED');
  const row = db.getApprovalRequest(id);
  assert.equal(row.state, 'APPROVED');
});

test('C6: Brain cannot self-approve via ingestStatus with brain source', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  // Try to pass 'brain_submit' as source — state machine must reject it.
  const sm = require('../src/governance/approvalStateMachine');
  const check = sm.canTransition('SUBMITTED', 'APPROVED', sm.SOURCES.BRAIN_SUBMIT);
  assert.equal(check.ok, false, 'Brain source must not be able to approve');
  // State unchanged.
  const row = db.getApprovalRequest(id);
  assert.equal(row.state, 'SUBMITTED');
});

// =============================================================================
// D. State machine invariants
// =============================================================================

test('D1: PENDING_SUBMISSION cannot be approved directly (must submit first)', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'PENDING_SUBMISSION',
  });
  const r = governance.ingestStatus(id, { decision: 'approved', source: 'omstudio_ingest' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /transition_not_allowed/);
});

test('D2: APPROVED approval cannot be rejected (terminal state)', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  governance.ingestStatus(id, { decision: 'approved', source: 'dryrun_sim' });
  const r = governance.ingestStatus(id, { decision: 'rejected', source: 'omstudio_ingest' });
  assert.equal(r.ok, false);
});

test('D3: unrecognized decision string is rejected', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  const r = governance.ingestStatus(id, { decision: 'maybe', source: 'omstudio_ingest' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unrecognized_external_decision');
});

test('D4: approval history is append-only (3 rows for create+submit+approve)', () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'PENDING_SUBMISSION',
  });
  // Manually advance to SUBMITTED (simulating Brain submit).
  const sm = require('../src/governance/approvalStateMachine');
  db.advanceApprovalState({
    approval_id: id,
    from_state: 'PENDING_SUBMISSION',
    to_state: 'SUBMITTED',
    source: sm.SOURCES.BRAIN_SUBMIT,
    note: 'submitted',
    omstudio_ref: 'oms-test-ref',
  });
  governance.ingestStatus(id, { decision: 'approved', source: 'dryrun_sim' });
  const hist = db.approvalHistory(id);
  assert.equal(hist.length, 3);
  assert.equal(hist[0].to_state, 'PENDING_SUBMISSION');
  assert.equal(hist[1].to_state, 'SUBMITTED');
  assert.equal(hist[2].to_state, 'APPROVED');
});

// =============================================================================
// E. New Brain endpoints
// =============================================================================

test('E1: GET /governance/health returns transport and circuit-breaker posture', async () => {
  const { db, governance } = freshBrainStack();
  const { baseUrl, close } = await startBrainServer({ db, governance });
  try {
    const r = await jsonFetch(`${baseUrl}/governance/health`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok('transport' in r.json);
    assert.ok('webhook_secret_configured' in r.json);
  } finally {
    await close();
  }
});

test('E2: GET /governance/approvals/:id/history returns append-only history', async () => {
  const { db, governance } = freshBrainStack();
  const id = db.createApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'test',
    state: 'SUBMITTED',
  });
  governance.ingestStatus(id, { decision: 'approved', source: 'dryrun_sim' });

  const { baseUrl, close } = await startBrainServer({ db, governance });
  try {
    const r = await jsonFetch(`${baseUrl}/governance/approvals/${id}/history`);
    assert.equal(r.status, 200);
    assert.equal(r.json.approval_id, id);
    assert.ok(r.json.count >= 2);
    const toStates = r.json.history.map((h) => h.to_state);
    assert.ok(toStates.includes('SUBMITTED'));
    assert.ok(toStates.includes('APPROVED'));
  } finally {
    await close();
  }
});

test('E3: GET /governance/approvals/:id/history returns 404 for unknown id', async () => {
  const { db, governance } = freshBrainStack();
  const { baseUrl, close } = await startBrainServer({ db, governance });
  try {
    const r = await jsonFetch(`${baseUrl}/governance/approvals/99999/history`);
    assert.equal(r.status, 404);
  } finally {
    await close();
  }
});

// =============================================================================
// F. Governance health check method
// =============================================================================

test('F1: checkGovernanceHealth returns ok:true in dryrun mode', async () => {
  const { omstudio } = freshBrainStack({ transport: 'dryrun' });
  const r = await omstudio.checkGovernanceHealth();
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'dryrun');
});

test('F2: checkGovernanceHealth is blocked for external host in production', async () => {
  const { omstudio } = freshBrainStack({
    transport: 'http',
    baseUrl: 'https://external.example.com',
    production: true,
    httpImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  const r = await omstudio.checkGovernanceHealth();
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
});

test('F3: checkGovernanceHealth succeeds for LAN host in http mode', async () => {
  const { omstudio } = freshBrainStack({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    production: true,
    httpImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, service: 'omstudio-brain-governance' }),
    }),
  });
  const r = await omstudio.checkGovernanceHealth();
  assert.equal(r.ok, true);
  assert.equal(r.transport, 'http');
});
