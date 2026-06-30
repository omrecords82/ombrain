'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assessOpsJwt, validateIngestAuthConfig } = require('../src/ingest/opsAuth');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function fakeJwt(payload) {
  return `aaa.${b64url(payload)}.bbb`;
}

test('assessOpsJwt flags missing token', () => {
  const r = assessOpsJwt('');
  assert.strictEqual(r.configured, false);
  assert.strictEqual(r.valid, false);
});

test('assessOpsJwt flags expired token', () => {
  const r = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60, role: 'brain_ingest' }));
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'expired');
});

test('validateIngestAuthConfig reports missing jwt when adapters enabled', () => {
  const out = validateIngestAuthConfig({
    jwt: '',
    jwtVarName: 'BRAIN_OPS_JWT',
    apiBaseUrl: 'http://192.168.1.239:7060',
    enableEventAdapter: true,
    enableInventoryAdapter: false,
    enableLogAdapter: false,
  });
  assert.ok(out.issues.some((i) => i.code === 'missing_jwt'));
});
