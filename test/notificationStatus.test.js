'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNotificationStatus,
  deriveOverallStatus,
} = require('../src/health/notificationStatus');

test('local sink success does not produce overall verified', () => {
  const n = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'unconfigured',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
  });
  assert.equal(n.local_sink, 'verified');
  assert.equal(n.overall_status, 'degraded');
  assert.equal(n.status, 'degraded');
  assert.notEqual(n.overall_status, 'verified');
});

test('operator receipt is required for overall verified', () => {
  const without = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
  });
  assert.equal(without.overall_status, 'degraded');

  const withReceipt = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'verified',
  });
  assert.equal(withReceipt.overall_status, 'verified');
  assert.equal(withReceipt.status, 'verified');
});

test('external transport failure produces degraded or failed', () => {
  const failed = deriveOverallStatus({
    command_execution: 'verified',
    local_sink: 'verified',
    external_transport: 'failed',
    operator_receipt: 'unverified',
  });
  assert.equal(failed, 'failed');

  const receiptFailed = deriveOverallStatus({
    command_execution: 'verified',
    local_sink: 'verified',
    external_transport: 'verified',
    operator_receipt: 'failed',
  });
  assert.equal(receiptFailed, 'degraded');

  const unconfigured = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'unconfigured',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
  });
  assert.equal(unconfigured.overall_status, 'degraded');
});

test('notification status includes timestamps and evidence reference', () => {
  const n = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
    BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT: '2026-08-05T02:00:00Z',
    BRAIN_NAGIOS_NOTIFICATION_TEST_REFERENCE: 'OMBRAIN-SMTP-PROBE-20260805',
    BRAIN_NAGIOS_NOTIFICATION_DETAIL: 'transport accepted; awaiting operator receipt',
  });
  assert.equal(n.last_tested_at, '2026-08-05T02:00:00Z');
  assert.equal(n.test_reference, 'OMBRAIN-SMTP-PROBE-20260805');
  assert.match(n.detail, /awaiting operator receipt/);
  assert.equal(n.overall_status, 'degraded');
});

test('missing notification configuration reports unconfigured', () => {
  const n = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'unconfigured',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'unconfigured',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'unconfigured',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
  });
  assert.equal(n.overall_status, 'unconfigured');
  assert.equal(n.status, 'unconfigured');
});

test('legacy BRAIN_NAGIOS_NOTIFICATION_STATUS=verified is clamped to degraded', () => {
  const n = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_STATUS: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT: '2026-08-04T22:35:15Z',
    BRAIN_NAGIOS_NOTIFICATION_DETAIL: 'local receipt only',
  });
  assert.equal(n.command_execution, 'verified');
  assert.equal(n.local_sink, 'verified');
  assert.equal(n.external_transport, 'unconfigured');
  assert.equal(n.operator_receipt, 'unverified');
  assert.equal(n.overall_status, 'degraded');
  assert.equal(n.status, 'degraded');
});

test('env cannot force overall verified without operator receipt', () => {
  const n = buildNotificationStatus({
    BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT: 'verified',
    BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT: 'unverified',
    BRAIN_NAGIOS_NOTIFICATION_OVERALL_STATUS: 'verified',
  });
  assert.equal(n.overall_status, 'degraded');
});
