'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Fresh module load per test file run.
const adapterStatus = require('../src/health/adapterStatus');

test('snapshot reports auth_degraded when ops JWT expired', () => {
  adapterStatus.setEnabled('inventory', true);
  adapterStatus.setOpsAuthContext({
    valid: false,
    reason: 'expired',
    days_until_expiry: -3,
  });
  adapterStatus.recordPoll('inventory', { ok: true, status: 200 });
  const snap = adapterStatus.snapshot();
  assert.strictEqual(snap.inventory.state, 'auth_degraded');
  assert.strictEqual(snap.inventory.last_error, 'ops_jwt_expired');
  assert.match(snap.inventory.auth_message, /expired/i);
});

test('snapshot keeps ok when ops JWT valid', () => {
  adapterStatus.setEnabled('events', true);
  adapterStatus.setOpsAuthContext({
    valid: true,
    reason: null,
    days_until_expiry: 90,
  });
  adapterStatus.recordPoll('events', { ok: true, status: 200 });
  const snap = adapterStatus.snapshot();
  assert.strictEqual(snap.events.state, 'ok');
});

test('recordPoll uses auth_degraded not auth_error when JWT invalid', () => {
  adapterStatus.setEnabled('deploy_runs', true);
  adapterStatus.setOpsAuthContext({
    valid: false,
    reason: 'missing',
    days_until_expiry: null,
  });
  adapterStatus.recordPoll('deploy_runs', { ok: false, status: 401 });
  const snap = adapterStatus.snapshot();
  assert.strictEqual(snap.deploy_runs.state, 'auth_degraded');
  assert.strictEqual(snap.deploy_runs.last_error, 'ops_jwt_missing');
});
