'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyOwnerConfirmation,
  saveEvidence,
  loadEvidence,
  buildNotificationStatusFromEvidence,
  emptyEvidence,
  seedEvidenceFromEnv,
} = require('../src/health/notificationEvidence');
const { deriveOverallStatus } = require('../src/health/notificationStatus');

function tmpEvidencePath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ombrain-notif-')),
    'notification-evidence.json',
  );
}

test('owner confirmation YES sets operator receipt verified', () => {
  const base = {
    ...emptyEvidence(),
    command_result: 'verified',
    local_sink_result: 'verified',
    transport_result: 'verified',
    operator_confirmation_result: 'unverified',
    test_reference: 'OMBRAIN-OPALERT-20260805T020519Z',
  };
  const updated = applyOwnerConfirmation(base, {
    received: 'YES',
    confirmedAt: '2026-08-05T17:00:00Z',
    source: 'owner_turn',
  });
  assert.equal(updated.operator_confirmation_result, 'verified');
  assert.equal(updated.confirmation_time, '2026-08-05T17:00:00Z');
  assert.equal(updated.derived_status, 'verified');
});

test('overall verified only when every required dimension is verified', () => {
  assert.equal(
    deriveOverallStatus({
      command_execution: 'verified',
      local_sink: 'verified',
      external_transport: 'verified',
      operator_receipt: 'verified',
    }),
    'verified',
  );
  assert.equal(
    deriveOverallStatus({
      command_execution: 'verified',
      local_sink: 'verified',
      external_transport: 'verified',
      operator_receipt: 'unverified',
    }),
    'degraded',
  );
});

test('failed or absent receipt keeps overall status degraded', () => {
  const no = applyOwnerConfirmation(
    {
      ...emptyEvidence(),
      command_result: 'verified',
      local_sink_result: 'verified',
      transport_result: 'verified',
    },
    { received: 'NO', confirmedAt: '2026-08-05T17:00:00Z', source: 'owner_turn' },
  );
  assert.equal(no.operator_confirmation_result, 'failed');
  assert.equal(no.derived_status, 'degraded');

  const placeholder = applyOwnerConfirmation(
    {
      ...emptyEvidence(),
      command_result: 'verified',
      local_sink_result: 'verified',
      transport_result: 'verified',
    },
    { received: '[YES OR NO]', confirmedAt: '2026-08-05T17:00:00Z', source: 'owner_turn' },
  );
  assert.equal(placeholder.operator_confirmation_result, 'unverified');
  assert.equal(placeholder.derived_status, 'degraded');
});

test('notification evidence survives restart (reload from disk)', () => {
  const filePath = tmpEvidencePath();
  const saved = saveEvidence(
    {
      ...emptyEvidence(),
      test_reference: 'OMBRAIN-OPALERT-20260805T020519Z',
      test_timestamp: '2026-08-05T02:05:19Z',
      command_result: 'verified',
      local_sink_result: 'verified',
      transport_result: 'verified',
      operator_confirmation_result: 'unverified',
      detail: 'awaiting owner confirmation',
    },
    filePath,
  );
  assert.equal(saved.derived_status, 'degraded');

  // Simulate restart: empty env, load only from durable file.
  const reloaded = buildNotificationStatusFromEvidence({}, filePath);
  assert.equal(reloaded.evidence_loaded, true);
  assert.equal(reloaded.test_reference, 'OMBRAIN-OPALERT-20260805T020519Z');
  assert.equal(reloaded.command_execution, 'verified');
  assert.equal(reloaded.operator_receipt, 'unverified');
  assert.equal(reloaded.overall_status, 'degraded');
  assert.notEqual(reloaded.overall_status, 'verified');

  // Missing file must not invent verified/healthy.
  const missingPath = path.join(path.dirname(filePath), 'missing.json');
  const missing = buildNotificationStatusFromEvidence({}, missingPath);
  assert.equal(missing.evidence_loaded, false);
  assert.notEqual(missing.overall_status, 'verified');
});

test('seedEvidenceFromEnv writes durable file without promoting receipt', () => {
  const filePath = tmpEvidencePath();
  seedEvidenceFromEnv(
    {
      BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
      BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
      BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'verified',
      BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
      BRAIN_NAGIOS_NOTIFICATION_TEST_REFERENCE: 'OMBRAIN-OPALERT-20260805T020519Z',
      BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT: '2026-08-05T02:05:19Z',
    },
    filePath,
  );
  const loaded = loadEvidence(filePath);
  assert.equal(loaded.operator_confirmation_result, 'unverified');
  assert.equal(loaded.derived_status, 'degraded');
});
