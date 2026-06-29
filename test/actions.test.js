'use strict';

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../../_runtime/server/src/services/brainActionRegistry');

test('brainActionRegistry lists seeded OMAI actions', () => {
  const actions = registry.listActions({ source: 'omai' });
  assert.ok(actions.length >= 2);
  const ids = actions.map((a) => a.id);
  assert.ok(ids.includes('omai.system.status'));
  assert.ok(ids.includes('omai.services.health_check'));
});

test('brainActionRegistry resolve matches system status queries', () => {
  const match = registry.resolveAction('check full system status');
  assert.ok(match);
  assert.strictEqual(match.action.id, 'omai.system.status');
  assert.ok(match.confidence > 0.5);
});

test('brainActionRegistry resolve matches health check queries', () => {
  const match = registry.resolveAction('run service health check on omai');
  assert.ok(match);
  assert.strictEqual(match.action.id, 'omai.services.health_check');
});

test('brainActionRegistry getAction returns public contract', () => {
  const action = registry.getAction('omai.system.status');
  assert.ok(action);
  assert.strictEqual(action.risk, 'read');
  assert.strictEqual(action.mutation, false);
  assert.ok(action.required_roles.includes('brain_ingest'));
});

test('brainActionRegistry runAction dry-run without auth user fails closed on role', async () => {
  await assert.rejects(
    () => registry.runAction('omai.system.status', { req: {}, dry_run: true }),
    (err) => err.statusCode === 403,
  );
});

test('brainActionRegistry runAction allows brain_ingest read dry-run', async () => {
  const out = await registry.runAction('omai.system.status', {
    req: { user: { id: 1, role: 'brain_ingest', email: 'brain@test' }, ip: '127.0.0.1', headers: {} },
    dry_run: true,
    commit: false,
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.dry_run, true);
  assert.strictEqual(out.action_id, 'omai.system.status');
});

test('actionBridge rejects mutation without commit', async () => {
  const bridge = require('../src/actions/actionBridge');
  const client = require('../src/actions/omaiActionClient');
  const orig = client.getAction;
  client.getAction = async () => ({
    ok: true,
    action: {
      id: 'test.write',
      mutation: true,
      risk: 'medium',
      supports_dry_run: true,
      required_roles: ['super_admin'],
    },
  });
  try {
    await assert.rejects(
      () => bridge.runAction('test.write', { commit: false }),
      (err) => err.code === 'commit_required',
    );
  } finally {
    client.getAction = orig;
  }
});
