'use strict';

/**
 * OMAI Action API client — authenticated HTTP bridge from om-brain to OMAI brain-actions.
 *
 * Uses BRAIN_OPS_JWT (brain_ingest role) or OMSTUDIO_SERVICE_TOKEN when configured.
 * Never logs secret values.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

function omaiActionsConfig() {
  const omai = config.omai || {};
  return {
    baseUrl: omai.apiBaseUrl || config.ingest.apiBaseUrl || 'http://192.168.1.239:7060',
    actionsPath: omai.actionsPath || '/api/omai/brain-actions',
    jwt: omai.jwt || config.ingest.jwt || '',
    serviceToken: omai.serviceToken || config.omstudio?.serviceToken || '',
    timeoutMs: omai.timeoutMs || 30000,
  };
}

function buildUrl(path, query) {
  const cfg = omaiActionsConfig();
  const u = new URL(path, cfg.baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') u.searchParams.set(k, v);
    }
  }
  return u;
}

function authHeaders() {
  const cfg = omaiActionsConfig();
  const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (cfg.jwt) {
    h.Authorization = `Bearer ${cfg.jwt}`;
  } else if (cfg.serviceToken) {
    h['X-Service-Token'] = cfg.serviceToken;
    h['X-Source-System'] = 'om-brain';
  }
  return h;
}

function httpRequest(method, url, body) {
  const cfg = omaiActionsConfig();
  const payload = body != null ? JSON.stringify(body) : null;
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: authHeaders(),
      timeout: cfg.timeoutMs,
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {
          parsed = { raw: data };
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('omai_action_timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function mapError(status, body) {
  const err = new Error(
    (body && (body.message || body.error)) || `OMAI action API error (${status})`,
  );
  err.statusCode = status;
  err.code = body && body.error;
  err.body = body;
  return err;
}

async function listActions(filters = {}) {
  const url = buildUrl(omaiActionsConfig().actionsPath + '/', filters);
  const { status, body } = await httpRequest('GET', url);
  if (status === 401 || status === 403) throw mapError(status, body);
  if (status >= 400) throw mapError(status, body);
  return body;
}

async function getAction(actionId) {
  const url = buildUrl(`${omaiActionsConfig().actionsPath}/${encodeURIComponent(actionId)}`);
  const { status, body } = await httpRequest('GET', url);
  if (status === 404) throw mapError(status, body || { error: 'action_not_found' });
  if (status === 401 || status === 403) throw mapError(status, body);
  if (status >= 400) throw mapError(status, body);
  return body;
}

async function resolveAction(query) {
  const url = buildUrl(`${omaiActionsConfig().actionsPath}/resolve`);
  const { status, body } = await httpRequest('POST', url, { query: String(query || '').trim() });
  if (status === 401 || status === 403) throw mapError(status, body);
  if (status >= 400) throw mapError(status, body);
  return body;
}

async function runAction(actionId, opts = {}) {
  const url = buildUrl(`${omaiActionsConfig().actionsPath}/${encodeURIComponent(actionId)}/run`);
  const payload = {
    input: opts.input,
    dry_run: opts.dry_run,
    commit: opts.commit,
    confirmed: opts.confirmed,
  };
  const { status, body } = await httpRequest('POST', url, payload);
  if (status === 401 || status === 403) throw mapError(status, body);
  if (status >= 400) throw mapError(status, body);
  logger.info('omai_action_run', redactForLog({
    action_id: actionId,
    dry_run: body && body.dry_run,
    committed: body && body.committed,
    ok: body && body.ok,
  }));
  return body;
}

async function listHistory(limit) {
  const url = buildUrl(`${omaiActionsConfig().actionsPath}/history`, { limit });
  const { status, body } = await httpRequest('GET', url);
  if (status === 401 || status === 403) throw mapError(status, body);
  if (status >= 400) throw mapError(status, body);
  return body;
}

function isConfigured() {
  const cfg = omaiActionsConfig();
  return !!(cfg.jwt || cfg.serviceToken);
}

module.exports = {
  omaiActionsConfig,
  listActions,
  getAction,
  resolveAction,
  runAction,
  listHistory,
  isConfigured,
};
