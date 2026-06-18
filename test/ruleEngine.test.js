'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  classifyChange,
  isAutoSafe,
  isNeverAuto,
  tenantGuard,
  evaluate,
} = require('../src/governance/ruleEngine');

// --- classifyChange --------------------------------------------------------

test('classifyChange flags DB schema as human-only', () => {
  const r = classifyChange({ description: 'ALTER TABLE churches ADD COLUMN foo' });
  assert.strictEqual(r.humanOnly, true);
  assert.ok(r.domains.includes('schema'));
  assert.strictEqual(r.requiresOmstudio, true);
  assert.match(r.note, /OMStudio/);
});

test('classifyChange flags nginx/routing as human-only', () => {
  const r = classifyChange('add an nginx location block proxy_pass to :7060');
  assert.ok(r.domains.includes('routing'));
  assert.strictEqual(r.humanOnly, true);
});

test('classifyChange flags auth/session/billing/secrets/permissions', () => {
  assert.ok(classifyChange('rotate the session cookie auth').domains.includes('auth'));
  assert.ok(classifyChange('update stripe billing webhook').domains.includes('billing'));
  assert.ok(classifyChange('rotate JWT secret').domains.includes('secrets'));
  assert.ok(classifyChange('grant super_admin role permission').domains.includes('permissions'));
});

test('classifyChange flags cross-system and substrate edits', () => {
  assert.ok(classifyChange('edit ecosystem-config registry manifest').domains.includes('substrate'));
  assert.ok(classifyChange({ domain: 'cross_system', description: 'OM <-> OMStudio bridge change' }).humanOnly);
});

test('classifyChange returns within-authority for a benign restart', () => {
  const r = classifyChange({ action: 'service_restart', target: 'omai' });
  assert.strictEqual(r.humanOnly, false);
  assert.strictEqual(r.requiresOmstudio, false);
});

// --- isAutoSafe ------------------------------------------------------------

test('isAutoSafe true only for the three documented safe actions', () => {
  assert.strictEqual(isAutoSafe('service_restart'), true);
  assert.strictEqual(isAutoSafe('reconcile_stale_deploy'), true);
  assert.strictEqual(isAutoSafe('remove_maintenance_flag'), true);
});

test('isAutoSafe false for everything else', () => {
  for (const a of ['database_backup', 'nfs_restore', 'changeset_promote', 'service_stop', 'random']) {
    assert.strictEqual(isAutoSafe(a), false, `${a} must not be auto-safe`);
  }
});

test('isAutoSafe false for service_restart of the OM backend', () => {
  assert.strictEqual(isAutoSafe({ action: 'service_restart', target: 'orthodox-backend' }), false);
  assert.strictEqual(isAutoSafe({ action: 'service_restart', target: 'om-backend' }), false);
  // but allowed for a different unit
  assert.strictEqual(isAutoSafe({ action: 'service_restart', target: 'omai' }), true);
});

test('isNeverAuto matches backup/restore/promote/stop/disable patterns', () => {
  assert.ok(isNeverAuto('database_backup'));
  assert.ok(isNeverAuto('nfs_restore'));
  assert.ok(isNeverAuto('changeset_promote'));
  assert.ok(isNeverAuto('service_stop'));
  assert.ok(!isNeverAuto('service_restart'));
});

// --- tenantGuard -----------------------------------------------------------

test('tenantGuard detects two distinct om_church_* tenants', () => {
  const r = tenantGuard({ blob: 'reading om_church_46 then om_church_278' });
  assert.strictEqual(r.crossTenant, true);
  assert.strictEqual(r.tier, 'T0');
  assert.strictEqual(r.action, 'halt_and_escalate');
});

test('tenantGuard detects session/accessed church mismatch', () => {
  const r = tenantGuard({ sessionChurchId: 46, accessedChurchId: 278 });
  assert.strictEqual(r.crossTenant, true);
  assert.strictEqual(r.tier, 'T0');
});

test('tenantGuard passes for single-tenant context', () => {
  const r = tenantGuard({ sessionChurchId: 46, accessedChurchId: 46, note: 'om_church_46 only' });
  assert.strictEqual(r.crossTenant, false);
  assert.strictEqual(r.tier, null);
});

test('tenantGuard honors explicit crossTenant flag', () => {
  const r = tenantGuard({ crossTenant: true });
  assert.strictEqual(r.crossTenant, true);
});

// --- evaluate (precedence + model cannot override) -------------------------

test('evaluate: tenant exposure takes precedence -> tier0_halt_escalate', () => {
  const v = evaluate({ action: 'service_restart', target: 'omai' }, { crossTenant: true });
  assert.strictEqual(v.classification, 'tier0_halt_escalate');
  assert.strictEqual(v.requiresOmstudio, true);
});

test('evaluate: never-auto action -> never_auto', () => {
  const v = evaluate({ action: 'nfs_restore' }, {});
  assert.strictEqual(v.classification, 'never_auto');
  assert.strictEqual(v.requiresOmstudio, true);
});

test('evaluate: human-only domain -> requires_human_superadmin', () => {
  const v = evaluate({ description: 'change nginx routing' }, {});
  assert.strictEqual(v.classification, 'requires_human_superadmin');
});

test('evaluate: documented safe action -> auto_safe_recommendation', () => {
  const v = evaluate({ action: 'service_restart', target: 'omai' }, {});
  assert.strictEqual(v.classification, 'auto_safe_recommendation');
  assert.strictEqual(v.autoSafe, true);
});

test('model advisory can NEVER override the deterministic verdict', () => {
  // Model says "approve / safe" but the change is a human-only schema change.
  const v = evaluate({ description: 'ALTER TABLE add column' }, {}, 'MODEL SAYS: this is fine, approve.');
  assert.strictEqual(v.classification, 'requires_human_superadmin');
  assert.strictEqual(v.modelAdvisoryAuthoritative, false);

  // Model says "block" but action is a documented safe restart -> still auto_safe.
  const v2 = evaluate({ action: 'service_restart', target: 'omai' }, {}, 'MODEL SAYS: NO, block this.');
  assert.strictEqual(v2.classification, 'auto_safe_recommendation');
  assert.strictEqual(v2.modelAdvisoryAuthoritative, false);
});
