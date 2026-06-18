'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  redactForModel,
  redactForLog,
  isSecretKey,
  isTenantKey,
  REDACTED,
  TENANT_TOKEN,
} = require('../src/ai/redactor');

test('redacts never-log secret keys by name', () => {
  const out = redactForModel({
    DB_PASSWORD: 'hunter2',
    SESSION_SECRET: 'abc',
    JWT_ACCESS_SECRET: 'x',
    JWT_REFRESH_SECRET: 'y',
    STRIPE_SECRET_KEY: 'sk_live_123',
    OMSTUDIO_SERVICE_TOKEN: 'tok',
    GH_TOKEN: 'ghp_xyz',
    harmless: 'keep-me',
  });
  assert.strictEqual(out.DB_PASSWORD, REDACTED);
  assert.strictEqual(out.SESSION_SECRET, REDACTED);
  assert.strictEqual(out.JWT_ACCESS_SECRET, REDACTED);
  assert.strictEqual(out.JWT_REFRESH_SECRET, REDACTED);
  assert.strictEqual(out.STRIPE_SECRET_KEY, REDACTED);
  assert.strictEqual(out.OMSTUDIO_SERVICE_TOKEN, REDACTED);
  assert.strictEqual(out.GH_TOKEN, REDACTED);
  assert.strictEqual(out.harmless, 'keep-me');
});

test('redacts tenant identifiers (church_id key + om_church_* values)', () => {
  const out = redactForModel({
    church_id: 46,
    note: 'data lives in om_church_278 and om_church_46',
  });
  assert.strictEqual(out.church_id, TENANT_TOKEN);
  assert.ok(!String(out.note).includes('om_church_278'));
  assert.ok(String(out.note).includes(TENANT_TOKEN));
});

test('redacts JWT / bearer / PEM / stripe tokens embedded in free text', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactForModel({
    msg: `token=${jwt} and Authorization: Bearer abc.def-123 and sk_live_abcd1234`,
  });
  assert.ok(!out.msg.includes('eyJhbGci'));
  assert.ok(!out.msg.includes('sk_live_abcd1234'));
  assert.ok(out.msg.includes(REDACTED));
});

test('redacts PEM private key blocks', () => {
  const pem =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nbbbb\n-----END OPENSSH PRIVATE KEY-----';
  const out = redactForLog({ key: pem });
  // key name "key" also matches a secret pattern, so value is fully redacted.
  assert.strictEqual(out.key, REDACTED);
  const out2 = redactForLog({ blob: pem });
  assert.ok(!out2.blob.includes('BEGIN OPENSSH PRIVATE KEY'));
});

test('handles nested structures and arrays', () => {
  const out = redactForModel({
    level1: { DB_PASS: 'p', items: [{ jwt_secret: 's' }, { ok: 1 }] },
  });
  assert.strictEqual(out.level1.DB_PASS, REDACTED);
  assert.strictEqual(out.level1.items[0].jwt_secret, REDACTED);
  assert.strictEqual(out.level1.items[1].ok, 1);
});

test('handles circular references without throwing', () => {
  const a = { name: 'x' };
  a.self = a;
  const out = redactForLog(a);
  assert.strictEqual(out.name, 'x');
  assert.strictEqual(out.self, '[CIRCULAR]');
});

test('isSecretKey / isTenantKey helpers', () => {
  assert.ok(isSecretKey('JWT_REFRESH_SECRET'));
  assert.ok(isSecretKey('stripe_webhook_secret'));
  assert.ok(!isSecretKey('hostname'));
  assert.ok(isTenantKey('church_id'));
  assert.ok(isTenantKey('database_name'));
  assert.ok(!isTenantKey('server_id'));
});
