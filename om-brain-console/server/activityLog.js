'use strict';

const MAX = 200;
const rows = [];

function newRequestId() {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

function inferCapability(endpoint) {
  const ep = String(endpoint || '').toLowerCase();
  if (ep.includes('/ask')) return 'ask';
  if (ep.includes('/skills')) return 'skills';
  if (ep.includes('/diagnose')) return 'diagnostics';
  if (ep.includes('/governance')) return 'governance';
  if (ep.includes('/health')) return 'health';
  if (ep.includes('/actions')) return 'actions';
  if (ep.includes('/teach')) return 'teaching';
  return 'general';
}

function inferLabel(endpoint, method) {
  const ep = String(endpoint || '');
  const cap = inferCapability(ep);
  return `${method} ${ep}`.trim() || cap;
}

function logBrainActivity(entry) {
  const row = {
    request_id: entry.requestId || newRequestId(),
    timestamp: new Date().toISOString(),
    user_id: entry.userId ?? null,
    user_role: entry.userRole ?? 'console',
    endpoint: entry.endpoint,
    method: entry.method || 'GET',
    capability: entry.capability || inferCapability(entry.endpoint),
    governance: entry.governance || 'read-only',
    latency_ms: entry.latencyMs ?? 0,
    outcome: entry.outcome || (entry.statusCode >= 400 ? 'error' : 'success'),
    label: entry.label || inferLabel(entry.endpoint, entry.method),
    error_summary: entry.errorSummary ?? null,
  };
  rows.unshift(row);
  if (rows.length > MAX) rows.length = MAX;
  return row;
}

function listBrainActivity(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX);
  return { count: Math.min(rows.length, n), activity: rows.slice(0, n) };
}

module.exports = {
  newRequestId,
  inferCapability,
  logBrainActivity,
  listBrainActivity,
};
