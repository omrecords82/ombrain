'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmstudioClient } = require('../src/governance/omstudioClient');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ombox-'));
}

test('dry-run audit event lands in the outbox and is redacted', async () => {
  const dir = tmpDir();
  const client = new OmstudioClient({ transport: 'dryrun', outboxDir: dir });
  const res = await client.emitAuditEvent({
    decision_id: 1,
    classification: 'requires_human_superadmin',
    // secret + tenant that MUST be stripped
    DB_PASSWORD: 'hunter2',
    note: 'church_id 46 -> om_church_46 affected; token eyJabc.def.ghi',
  });
  assert.equal(res.ok, true);
  assert.equal(res.transport, 'dryrun');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'secret value must not be in outbox');
  assert.ok(!raw.includes('om_church_46'), 'tenant id must not be in outbox');
  assert.ok(raw.includes('[REDACTED]') || raw.includes('[TENANT_REDACTED]'));
});

test('dry-run approval request lands in the outbox', async () => {
  const dir = tmpDir();
  const client = new OmstudioClient({ transport: 'dryrun', outboxDir: dir });
  const res = await client.submitApprovalRequest({
    classification: 'requires_human_superadmin',
    proposal_summary: 'add nginx route',
  });
  assert.equal(res.ok, true);
  assert.ok(res.ref);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
});

test('http transport refuses an external host via the circuit breaker', async () => {
  let called = false;
  const client = new OmstudioClient({
    transport: 'http',
    baseUrl: 'https://api.openai.com/governance',
    production: true,
    httpImpl: async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  const verdict = client.checkEndpoint();
  assert.equal(verdict.allowed, false);
  const res = await client.emitAuditEvent({ decision_id: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(called, false, 'breaker must prevent the HTTP call');
});

test('http transport refuses a non-LAN host in production', async () => {
  const client = new OmstudioClient({
    transport: 'http',
    baseUrl: 'https://omstudio.orthodoxmetrics.com/omstudio-embed',
    production: true,
    httpImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  assert.equal(client.checkEndpoint().allowed, false);
});

test('http transport allows a LAN host and redacts the wire payload', async () => {
  let sentBody = null;
  let sentHeaders = null;
  const client = new OmstudioClient({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    serviceToken: 'omstudio-secret-token-xyz',
    production: true,
    httpImpl: async (url, opts) => {
      sentBody = opts.body;
      sentHeaders = opts.headers;
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'OMS-1' }) };
    },
  });
  assert.equal(client.checkEndpoint().allowed, true);
  const res = await client.emitAuditEvent({
    decision_id: 7,
    DB_PASSWORD: 'hunter2',
    note: 'affects om_church_278',
  });
  assert.equal(res.ok, true);
  assert.equal(res.ref, 'OMS-1');
  // payload redacted before egress
  assert.ok(!sentBody.includes('hunter2'));
  assert.ok(!sentBody.includes('om_church_278'));
  // service token only in the bearer header, never in the body
  assert.ok(!sentBody.includes('omstudio-secret-token-xyz'));
  assert.equal(sentHeaders.Authorization, 'Bearer omstudio-secret-token-xyz');
});

test('dry-run getApprovalStatus returns null state (status arrives via ingest)', async () => {
  const client = new OmstudioClient({ transport: 'dryrun', outboxDir: tmpDir() });
  const r = await client.getApprovalStatus('whatever');
  assert.equal(r.ok, true);
  assert.equal(r.state, null);
});
