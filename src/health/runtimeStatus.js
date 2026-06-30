'use strict';

const os = require('os');
const { config } = require('../config');
const { buildLlmStatus } = require('./llmStatus');
const adapterStatus = require('./adapterStatus');
const {
  assessOpsJwt,
  buildOpsAuthPublicStatus,
  opsAuthWarningMessage,
  shouldWarnOpsAuth,
} = require('../ingest/opsAuth');
const { resolveFleetTransport } = require('../fleet/natsClient');
const breaker = require('../ai/circuitBreaker');

async function probeNats() {
  const url = process.env.NATS_URL || '';
  if (!url) {
    return { configured: false, state: 'not_configured', transport: resolveFleetTransport() };
  }
  let host = null;
  try {
    host = new URL(url).hostname;
  } catch (_) {
    return { configured: true, url_host: null, state: 'invalid_url', transport: resolveFleetTransport() };
  }
  try {
    const { getNatsConnection } = require('../fleet/natsClient');
    const nc = await getNatsConnection({ url });
    const connected = nc && !nc.isClosed();
    return {
      configured: true,
      url_host: host,
      state: connected ? 'connected' : 'disconnected',
      transport: resolveFleetTransport(),
    };
  } catch (e) {
    return {
      configured: true,
      url_host: host,
      state: 'unreachable',
      transport: resolveFleetTransport(),
      reason: e && e.code ? String(e.code) : 'connect_failed',
    };
  }
}

async function buildRuntimeStatus(deps = {}) {
  const db = deps.db;
  const memoryBackend = db ? db.backendName() : 'none';
  const jwtAssessment = assessOpsJwt(config.ingest.jwt);
  adapterStatus.setOpsAuthContext(jwtAssessment);
  const opsAuth = buildOpsAuthPublicStatus(jwtAssessment);
  const opsAuthWarning = opsAuthWarningMessage(jwtAssessment);

  const verdict = breaker.checkHost(config.llm.baseUrl, { production: config.isProduction });
  let llm;
  try {
    llm = await buildLlmStatus({ memoryBackend });
  } catch (e) {
    llm = { status: 'error', last_error: 'llm_status_build_failed' };
  }

  const adapters = adapterStatus.snapshot();
  const recentAuthErrors = Object.entries(adapters)
    .filter(([, row]) => row.state === 'auth_error' || row.state === 'auth_degraded')
    .map(([name, row]) => ({
      adapter: name,
      state: row.state,
      last_status: row.last_status,
      last_error: row.last_error,
      auth_message: row.auth_message || null,
      last_poll_at: row.last_poll_at,
    }));

  const nats = await probeNats();
  const pkg = require('../../package.json');

  return {
    ok: true,
    service: 'om-brain',
    state: 'running',
    version: pkg.version || null,
    node_env: config.nodeEnv,
    uptime_sec: adapterStatus.uptimeSec(),
    hostname: os.hostname(),
    bind: { host: config.http.host, port: config.http.port },
    lan_api: process.env.BRAIN_LAN_API_URL || null,
    api: {
      local: `http://${config.http.host}:${config.http.port}`,
      lan: process.env.BRAIN_LAN_API_URL || null,
    },
    memory_backend: memoryBackend,
    executes_actions: false,
    llm: {
      status: llm.status,
      endpoint_allowed: verdict.allowed,
      endpoint_reason: verdict.reason,
    },
    nats,
    ops_auth: {
      ...opsAuth,
      api_base_url: config.ingest.apiBaseUrl,
      jwt_var: config.ingest.jwtVarName,
      warning: opsAuthWarning,
      needs_attention: shouldWarnOpsAuth(jwtAssessment),
    },
    adapters,
    recent_auth_errors: recentAuthErrors,
  };
}

module.exports = { buildRuntimeStatus, probeNats };
