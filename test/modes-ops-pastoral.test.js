'use strict';

/**
 * Tests for the rebuilt `ops` and `pastoral` modes (PR #282 fallout rebuild, 2026-06-28).
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { classifyIntent, listModes } = require('../src/modes/index');
const { handlePastoral, handleOps } = require('../src/queryPipeline/pipeline');

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

test('modes — pastoral and ops are registered', () => {
  const ids = listModes().map((m) => m.id);
  assert.ok(ids.includes('pastoral'), 'pastoral mode registered');
  assert.ok(ids.includes('ops'), 'ops mode registered');
});

test('classifyIntent — pastoral cases', () => {
  assert.strictEqual(classifyIntent('how do I prepare for confession'), 'pastoral');
  assert.strictEqual(classifyIntent('I am struggling with despair and grief'), 'pastoral');
  assert.strictEqual(classifyIntent('how do I find forgiveness'), 'pastoral');
});

test('classifyIntent — ops cases', () => {
  assert.strictEqual(classifyIntent('brain health status'), 'ops');
  assert.strictEqual(classifyIntent('should I restart the OMAI service'), 'ops');
  assert.strictEqual(classifyIntent('there is a 502 outage on nginx'), 'ops');
});

test('classifyIntent — no regression on existing modes', () => {
  assert.strictEqual(classifyIntent('when is Pascha 2027'), 'calendar');
  assert.strictEqual(classifyIntent('teach me the Jesus Prayer'), 'prayer');
  assert.strictEqual(classifyIntent('find an orthodox church near 10001'), 'church');
  assert.strictEqual(classifyIntent('what is theosis'), 'study');
  assert.strictEqual(classifyIntent('some random question'), 'general');
});

// ---------------------------------------------------------------------------
// Pastoral handler
// ---------------------------------------------------------------------------

test('handlePastoral — confession routes to confession answer with referral', async () => {
  const r = await handlePastoral('how do I prepare for confession');
  assert.strictEqual(r.type, 'pastoral.confession');
  assert.match(r.answer, /repentance|metanoia/i);
  assert.match(r.answer, /priest|spiritual father/i, 'must include clergy referral');
  assert.ok(r.referral, 'referral field present');
});

test('handlePastoral — grief and struggle have distinct types', async () => {
  const grief = await handlePastoral('I am grieving the loss of my mother');
  assert.strictEqual(grief.type, 'pastoral.grief');
  const struggle = await handlePastoral('I keep falling to the same temptation');
  assert.strictEqual(struggle.type, 'pastoral.struggle');
});

test('handlePastoral — every answer includes a clergy referral (safety)', async () => {
  for (const q of [
    'confession', 'I am grieving', 'temptation and despair', 'how do I forgive', 'general spiritual question',
  ]) {
    const r = await handlePastoral(q);
    assert.match(r.answer, /priest|spiritual father/i, `referral missing for: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// Ops handler
// ---------------------------------------------------------------------------

test('handleOps — status query returns fleet-health summary', async () => {
  const r = await handleOps('brain health status', {
    inventorySummary: { unreachable: 0, services_failed: 0, degraded: 0, critical_alerts: 0 },
  });
  assert.strictEqual(r.type, 'ops.status');
  assert.strictEqual(r.health.score, 100);
  assert.strictEqual(r.health.severity, 'healthy');
});

test('handleOps — action query requires governance and never executes', async () => {
  const r = await handleOps('should I restart the OMAI service', {
    inventorySummary: { unreachable: 1, services_failed: 0, degraded: 0, critical_alerts: 0 },
  });
  assert.strictEqual(r.type, 'ops.action_advisory');
  assert.strictEqual(r.requiresGovernance, true);
  assert.match(r.answer, /governance flow/i);
  assert.strictEqual(r.health.severity, 'degraded'); // 1 unreachable => 75
});

test('handleOps — unknown health when no inventory snapshot', async () => {
  const r = await handleOps('brain health status', {});
  assert.strictEqual(r.health.score, null);
  assert.strictEqual(r.health.severity, 'unknown');
});
