'use strict';

/**
 * In-process adapter poll status for /status and startup diagnostics.
 * Never stores secrets — only HTTP status codes and redacted error labels.
 */

const { opsAuthHealthLevel } = require('../ingest/opsAuth');

const startedAt = Date.now();

const adapters = Object.create(null);

/** Latest ops JWT assessment — set before snapshot from runtimeStatus / boot. */
let opsAuthContext = {
  valid: true,
  health: 'healthy',
  reason: null,
  days_until_expiry: null,
};

function ensure(name) {
  if (!adapters[name]) {
    adapters[name] = {
      enabled: false,
      state: 'disabled',
      last_status: null,
      last_error: null,
      last_poll_at: null,
      last_ok_at: null,
    };
  }
  return adapters[name];
}

function setOpsAuthContext(jwtAssessment) {
  opsAuthContext = {
    valid: !!jwtAssessment.valid,
    health: opsAuthHealthLevel(jwtAssessment),
    reason: jwtAssessment.reason || null,
    days_until_expiry: jwtAssessment.days_until_expiry != null
      ? jwtAssessment.days_until_expiry
      : null,
  };
}

function authDegradedError() {
  if (opsAuthContext.reason === 'expired') return 'ops_jwt_expired';
  if (opsAuthContext.health === 'missing') return 'ops_jwt_missing';
  if (opsAuthContext.health === 'malformed') return 'ops_jwt_malformed';
  return 'ops_jwt_invalid';
}

function authDegradedMessage() {
  if (opsAuthContext.reason === 'expired') {
    return 'Ops JWT expired — re-provision with provision-brain-ingest.sh --update-auth01';
  }
  if (opsAuthContext.health === 'missing') {
    return 'Ops JWT not configured — set BRAIN_OPS_JWT via provision-brain-ingest.sh';
  }
  if (opsAuthContext.health === 'malformed') {
    return 'Ops JWT malformed — re-provision with provision-brain-ingest.sh --update-auth01';
  }
  return 'Ops JWT invalid — ingestion auth degraded';
}

function applyOpsAuthOverlay(row) {
  if (!row.enabled) return row;
  const copy = { ...row };
  if (!opsAuthContext.valid) {
    copy.state = 'auth_degraded';
    copy.last_error = authDegradedError();
    copy.auth_message = authDegradedMessage();
    return copy;
  }
  if (opsAuthContext.health === 'near_expiry') {
    copy.auth_warning = 'ops_jwt_near_expiry';
    copy.days_until_expiry = opsAuthContext.days_until_expiry;
    if (copy.state === 'auth_error') {
      copy.auth_message = 'HTTP auth error — verify BRAIN_OPS_JWT is current';
    }
  }
  return copy;
}

function setEnabled(name, enabled) {
  const row = ensure(name);
  row.enabled = !!enabled;
  if (!enabled) row.state = 'disabled';
}

function recordPoll(name, { ok, status, error } = {}) {
  const row = ensure(name);
  const now = new Date().toISOString();
  row.last_poll_at = now;
  if (typeof status === 'number') row.last_status = status;

  if (!opsAuthContext.valid) {
    row.state = 'auth_degraded';
    row.last_error = authDegradedError();
    return;
  }

  if (ok) {
    row.state = 'ok';
    row.last_error = null;
    row.last_ok_at = now;
    return;
  }
  if (status === 401 || status === 403) {
    row.state = 'auth_error';
    row.last_error = status === 401 ? 'unauthorized' : 'forbidden';
    return;
  }
  row.state = 'error';
  row.last_error = error || (status != null ? `http_${status}` : 'request_failed');
}

function snapshot() {
  const out = {};
  for (const [name, row] of Object.entries(adapters)) {
    out[name] = applyOpsAuthOverlay(row);
  }
  return out;
}

function uptimeSec() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

module.exports = {
  setEnabled,
  setOpsAuthContext,
  recordPoll,
  snapshot,
  uptimeSec,
  startedAt,
};
