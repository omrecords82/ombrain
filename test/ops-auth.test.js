'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  OPS_AUTH_WARN_DAYS,
  assessOpsJwt,
  validateIngestAuthConfig,
  buildOpsAuthPublicStatus,
  opsAuthHealthLevel,
  opsAuthWarningMessage,
  shouldWarnOpsAuth,
  daysUntilExpiry,
} = require('../src/ingest/opsAuth');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function fakeJwt(payload) {
  return `aaa.${b64url(payload)}.bbb`;
}

test('OPS_AUTH_WARN_DAYS is 14', () => {
  assert.strictEqual(OPS_AUTH_WARN_DAYS, 14);
});

test('assessOpsJwt flags missing token', () => {
  const r = assessOpsJwt('');
  assert.strictEqual(r.configured, false);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.days_until_expiry, null);
});

test('assessOpsJwt flags expired token', () => {
  const r = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60, role: 'brain_ingest' }));
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'expired');
  assert.ok(r.days_until_expiry <= 0);
});

test('assessOpsJwt flags malformed token', () => {
  const r = assessOpsJwt('not-a-jwt');
  assert.strictEqual(r.configured, true);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'malformed');
});

test('assessOpsJwt computes days_until_expiry for valid token', () => {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
  const r = assessOpsJwt(fakeJwt({ exp, role: 'brain_ingest' }));
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.days_until_expiry, 30);
});

test('opsAuthHealthLevel near_expiry within 14 days', () => {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 10;
  const jwt = assessOpsJwt(fakeJwt({ exp, role: 'brain_ingest' }));
  assert.strictEqual(opsAuthHealthLevel(jwt), 'near_expiry');
});

test('opsAuthHealthLevel healthy beyond 14 days', () => {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 60;
  const jwt = assessOpsJwt(fakeJwt({ exp, role: 'brain_ingest' }));
  assert.strictEqual(opsAuthHealthLevel(jwt), 'healthy');
});

test('buildOpsAuthPublicStatus never includes token fields', () => {
  const exp = Math.floor(Date.now() / 1000) + 86400 * 45;
  const jwt = assessOpsJwt(fakeJwt({ exp, role: 'brain_ingest' }));
  const pub = buildOpsAuthPublicStatus(jwt);
  assert.strictEqual(pub.valid, true);
  assert.ok(pub.expires_at);
  assert.strictEqual(pub.days_until_expiry, 45);
  assert.strictEqual(pub.warn_threshold_days, 14);
  assert.strictEqual(Object.keys(pub).includes('token'), false);
});

test('shouldWarnOpsAuth true for near expiry and expired', () => {
  const near = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 * 5 }));
  const expired = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }));
  const healthy = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 * 30 }));
  assert.strictEqual(shouldWarnOpsAuth(near), true);
  assert.strictEqual(shouldWarnOpsAuth(expired), true);
  assert.strictEqual(shouldWarnOpsAuth(healthy), false);
});

test('opsAuthWarningMessage for near expiry mentions days', () => {
  const jwt = assessOpsJwt(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 * 7 }));
  const msg = opsAuthWarningMessage(jwt);
  assert.match(msg, /7 day/);
  assert.match(msg, /BRAIN_OPS_JWT/);
});

test('daysUntilExpiry handles negative values', () => {
  assert.strictEqual(daysUntilExpiry(-3600), -1);
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
