'use strict';

/**
 * Durable Nagios notification-delivery evidence.
 *
 * Survives OMBrain restarts. Never defaults missing evidence to verified.
 * Secrets and private message bodies must not be stored.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeState,
  deriveOverallStatus,
  buildNotificationStatus,
} = require('./notificationStatus');

const DEFAULT_EVIDENCE_PATH =
  process.env.BRAIN_NAGIOS_NOTIFICATION_EVIDENCE_PATH ||
  '/var/lib/om-brain/notification-evidence.json';

function emptyEvidence() {
  return {
    schema_version: 1,
    test_reference: null,
    test_timestamp: null,
    command_result: 'unverified',
    local_sink_result: 'unverified',
    transport_result: 'unconfigured',
    operator_confirmation_result: 'unverified',
    confirmation_source: null,
    confirmation_time: null,
    owner_confirmation_raw: null,
    detail: null,
    derived_status: 'unverified',
    updated_at: null,
  };
}

function sanitizeEvidence(raw) {
  const base = emptyEvidence();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw };
  out.schema_version = 1;
  out.command_result = normalizeState(out.command_result);
  out.local_sink_result = normalizeState(out.local_sink_result);
  out.transport_result = normalizeState(out.transport_result, 'unconfigured');
  out.operator_confirmation_result = normalizeState(out.operator_confirmation_result);
  out.derived_status = deriveOverallStatus({
    command_execution: out.command_result,
    local_sink: out.local_sink_result,
    external_transport: out.transport_result,
    operator_receipt: out.operator_confirmation_result,
  });
  // Never persist secrets / mailbox addresses.
  if (out.detail != null) {
    out.detail = String(out.detail).replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      '[redacted-email]',
    );
  }
  delete out.destination;
  delete out.recipient;
  delete out.mailbox;
  delete out.password;
  delete out.secret;
  return out;
}

function loadEvidence(filePath = DEFAULT_EVIDENCE_PATH) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return sanitizeEvidence(JSON.parse(text));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return null;
    }
    // Corrupt / unreadable → treat as absent (fail closed to unverified via env).
    return null;
  }
}

function saveEvidence(evidence, filePath = DEFAULT_EVIDENCE_PATH) {
  const clean = sanitizeEvidence(evidence);
  clean.updated_at = new Date().toISOString();
  clean.derived_status = deriveOverallStatus({
    command_execution: clean.command_result,
    local_sink: clean.local_sink_result,
    external_transport: clean.transport_result,
    operator_receipt: clean.operator_confirmation_result,
  });
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o640);
  } catch (_) {
    /* best-effort on CIFS/odd mounts */
  }
  return clean;
}

/**
 * Apply owner mailbox confirmation.
 * received must be exactly YES or NO (case-insensitive). Placeholders rejected.
 */
function applyOwnerConfirmation(evidence, { received, confirmedAt, source }) {
  const current = sanitizeEvidence(evidence || emptyEvidence());
  const token = String(received || '')
    .trim()
    .toUpperCase();
  current.owner_confirmation_raw = token || null;
  current.confirmation_source = source || 'owner_turn';
  current.confirmation_time = confirmedAt || new Date().toISOString();

  if (token === 'YES') {
    current.operator_confirmation_result = 'verified';
  } else if (token === 'NO') {
    current.operator_confirmation_result = 'failed';
  } else {
    // Unresolved placeholder / missing — do not fabricate receipt.
    current.operator_confirmation_result = 'unverified';
  }

  current.derived_status = deriveOverallStatus({
    command_execution: current.command_result,
    local_sink: current.local_sink_result,
    external_transport: current.transport_result,
    operator_receipt: current.operator_confirmation_result,
  });
  return current;
}

/**
 * Build notification status preferring durable evidence over env when present.
 */
function buildNotificationStatusFromEvidence(env = process.env, filePath = DEFAULT_EVIDENCE_PATH) {
  const fromEnv = buildNotificationStatus(env);
  const evidence = loadEvidence(filePath);
  if (!evidence) {
    return {
      ...fromEnv,
      evidence_path: filePath,
      evidence_loaded: false,
    };
  }

  const command_execution = normalizeState(evidence.command_result, fromEnv.command_execution);
  const local_sink = normalizeState(evidence.local_sink_result, fromEnv.local_sink);
  const external_transport = normalizeState(
    evidence.transport_result,
    fromEnv.external_transport || 'unconfigured',
  );
  const operator_receipt = normalizeState(
    evidence.operator_confirmation_result,
    fromEnv.operator_receipt,
  );
  const overall_status = deriveOverallStatus({
    command_execution,
    local_sink,
    external_transport,
    operator_receipt,
  });

  return {
    command_execution,
    local_sink,
    external_transport,
    operator_receipt,
    overall_status,
    status: overall_status,
    last_tested_at: evidence.test_timestamp || fromEnv.last_tested_at,
    test_reference: evidence.test_reference || fromEnv.test_reference,
    detail: evidence.detail || fromEnv.detail,
    confirmation_source: evidence.confirmation_source,
    confirmation_time: evidence.confirmation_time,
    evidence_path: filePath,
    evidence_loaded: true,
  };
}

/**
 * Seed durable evidence from current env dimensions (idempotent overwrite of results).
 */
function seedEvidenceFromEnv(env = process.env, filePath = DEFAULT_EVIDENCE_PATH) {
  const status = buildNotificationStatus(env);
  const existing = loadEvidence(filePath) || emptyEvidence();
  const seeded = sanitizeEvidence({
    ...existing,
    test_reference: status.test_reference || existing.test_reference,
    test_timestamp: status.last_tested_at || existing.test_timestamp,
    command_result: status.command_execution,
    local_sink_result: status.local_sink,
    transport_result: status.external_transport,
    operator_confirmation_result: status.operator_receipt,
    detail: status.detail || existing.detail,
    confirmation_source: existing.confirmation_source,
    confirmation_time: existing.confirmation_time,
    owner_confirmation_raw: existing.owner_confirmation_raw,
  });
  return saveEvidence(seeded, filePath);
}

module.exports = {
  DEFAULT_EVIDENCE_PATH,
  emptyEvidence,
  sanitizeEvidence,
  loadEvidence,
  saveEvidence,
  applyOwnerConfirmation,
  buildNotificationStatusFromEvidence,
  seedEvidenceFromEnv,
};
