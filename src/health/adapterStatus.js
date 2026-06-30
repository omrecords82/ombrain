'use strict';

/**
 * In-process adapter poll status for /status and startup diagnostics.
 * Never stores secrets — only HTTP status codes and redacted error labels.
 */

const startedAt = Date.now();

const adapters = Object.create(null);

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
    out[name] = { ...row };
  }
  return out;
}

function uptimeSec() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

module.exports = {
  setEnabled,
  recordPoll,
  snapshot,
  uptimeSec,
  startedAt,
};
