'use strict';

/**
 * Nagios notification delivery status — evidence-based dimensions.
 *
 * Local receipt-log success must never collapse into overall `verified`.
 * Overall `verified` requires operator_receipt=verified.
 */

const ALLOWED = new Set([
  'verified',
  'degraded',
  'failed',
  'unconfigured',
  'unverified',
]);

function normalizeState(value, fallback = 'unverified') {
  const v = String(value || '').trim().toLowerCase();
  return ALLOWED.has(v) ? v : fallback;
}

/**
 * Derive overall_status from component dimensions.
 * Never invent success: local sink alone cannot yield verified.
 */
function deriveOverallStatus(parts) {
  const command = normalizeState(parts.command_execution);
  const local = normalizeState(parts.local_sink);
  const transport = normalizeState(parts.external_transport, 'unconfigured');
  const receipt = normalizeState(parts.operator_receipt);

  if ([command, local, transport, receipt].includes('failed')) {
    return 'failed';
  }
  if (receipt === 'verified' && transport === 'verified' && command === 'verified') {
    return 'verified';
  }
  if (
    command === 'unconfigured' &&
    local === 'unconfigured' &&
    (transport === 'unconfigured' || transport === 'unverified') &&
    receipt === 'unverified'
  ) {
    return 'unconfigured';
  }
  // Local sink success without operator receipt is degraded, not verified.
  if (command === 'verified' || local === 'verified') {
    if (receipt !== 'verified' || transport === 'unconfigured' || transport === 'failed') {
      return 'degraded';
    }
  }
  if (transport === 'unconfigured' || receipt === 'unverified') {
    return 'degraded';
  }
  return 'unverified';
}

/**
 * Build notification status object from env / config fragments.
 * Backward compatible: legacy BRAIN_NAGIOS_NOTIFICATION_STATUS maps to
 * overall_status only when granular fields are absent — and is clamped so
 * a misleading legacy `verified` cannot hide missing operator receipt.
 */
function buildNotificationStatus(env = process.env) {
  const hasGranular =
    env.BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION != null ||
    env.BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK != null ||
    env.BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT != null ||
    env.BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT != null ||
    env.BRAIN_NAGIOS_NOTIFICATION_OVERALL_STATUS != null;

  let command_execution = normalizeState(
    env.BRAIN_NAGIOS_NOTIFICATION_COMMAND_EXECUTION,
    hasGranular ? 'unverified' : 'unverified',
  );
  let local_sink = normalizeState(
    env.BRAIN_NAGIOS_NOTIFICATION_LOCAL_SINK,
    hasGranular ? 'unverified' : 'unverified',
  );
  let external_transport = normalizeState(
    env.BRAIN_NAGIOS_NOTIFICATION_EXTERNAL_TRANSPORT,
    hasGranular ? 'unconfigured' : 'unconfigured',
  );
  let operator_receipt = normalizeState(
    env.BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT,
    'unverified',
  );

  // Legacy single-field support: interpret prior "verified" as local-path only.
  const legacy = normalizeState(env.BRAIN_NAGIOS_NOTIFICATION_STATUS, '');
  if (!hasGranular && legacy) {
    if (legacy === 'verified') {
      // Do not trust legacy verified as operator delivery.
      command_execution = 'verified';
      local_sink = 'verified';
      external_transport = 'unconfigured';
      operator_receipt = 'unverified';
    } else if (legacy === 'failed') {
      command_execution = 'failed';
      local_sink = 'failed';
      external_transport = 'failed';
      operator_receipt = 'unverified';
    } else if (legacy === 'degraded') {
      command_execution = 'verified';
      local_sink = 'verified';
      external_transport = 'unconfigured';
      operator_receipt = 'unverified';
    } else if (legacy === 'unconfigured') {
      command_execution = 'unconfigured';
      local_sink = 'unconfigured';
      external_transport = 'unconfigured';
      operator_receipt = 'unverified';
    }
  }

  const derived = deriveOverallStatus({
    command_execution,
    local_sink,
    external_transport,
    operator_receipt,
  });

  // Explicit overall overrides only when it does not claim verified without receipt.
  let overall_status = normalizeState(
    env.BRAIN_NAGIOS_NOTIFICATION_OVERALL_STATUS,
    derived,
  );
  if (overall_status === 'verified' && operator_receipt !== 'verified') {
    overall_status = 'degraded';
  }
  if (overall_status === 'verified' && external_transport !== 'verified') {
    overall_status = 'degraded';
  }
  // Prefer derived when env overall is absent or would overstate.
  if (!env.BRAIN_NAGIOS_NOTIFICATION_OVERALL_STATUS) {
    overall_status = derived;
  } else if (derived === 'degraded' || derived === 'failed') {
    // Never allow env to overstate beyond evidence.
    if (overall_status === 'verified') overall_status = derived;
  }

  return {
    // Granular evidence dimensions
    command_execution,
    local_sink,
    external_transport,
    operator_receipt,
    overall_status,
    last_tested_at: env.BRAIN_NAGIOS_NOTIFICATION_LAST_TESTED_AT || null,
    test_reference: env.BRAIN_NAGIOS_NOTIFICATION_TEST_REFERENCE || null,
    detail: env.BRAIN_NAGIOS_NOTIFICATION_DETAIL || null,
    // Backward-compatible alias — always mirrors overall_status (never local-only).
    status: overall_status,
  };
}

module.exports = {
  ALLOWED,
  normalizeState,
  deriveOverallStatus,
  buildNotificationStatus,
};
