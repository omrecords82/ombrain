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

  const nagiosAdapter = adapters.nagios || null;
  const nagiosMeta = (nagiosAdapter && nagiosAdapter.meta) || null;
  let nagiosMonitoring = {
    enabled: !!(config.ingest && config.ingest.enableNagiosAdapter),
    adapter_state: nagiosAdapter ? nagiosAdapter.state : 'absent',
    freshness: nagiosMeta?.freshness || (config.ingest?.enableNagiosAdapter ? 'unknown' : 'disabled'),
    integration_health:
      nagiosMeta?.integration_health ||
      (config.ingest?.enableNagiosAdapter ? 'unknown' : 'disabled'),
    last_ok_at: nagiosAdapter ? nagiosAdapter.last_ok_at : null,
    last_poll_at: nagiosAdapter ? nagiosAdapter.last_poll_at : null,
    last_error: nagiosAdapter ? nagiosAdapter.last_error : null,
    hosts_total: nagiosMeta?.hosts_total ?? null,
    hosts_down: nagiosMeta?.hosts_down ?? null,
    services_total: nagiosMeta?.services_total ?? null,
    // Active problem totals exclude synthetic fixture services.
    services_critical: nagiosMeta?.services_critical ?? null,
    services_warning: nagiosMeta?.services_warning ?? null,
    services_unknown: nagiosMeta?.services_unknown ?? null,
    services_synthetic_excluded: nagiosMeta?.services_synthetic_excluded ?? null,
    last_event_at: nagiosMeta?.last_event_at ?? null,
    reconciliation: nagiosMeta?.reconciliation || null,
    mapping: nagiosMeta?.mapping || null,
    authentication: nagiosMeta?.authentication || {
      method: config.ingest?.nagiosAuthRequired ? 'basic_required' : 'none',
      configured: Boolean(config.ingest?.nagiosStatusUser),
      last_result: 'unknown',
    },
    notification: nagiosMeta?.notification ||
      config.ingest?.nagiosNotificationStatus || {
        status: 'unverified',
        last_tested_at: null,
      },
    active_problems: {
      hosts_down: nagiosMeta?.hosts_down ?? null,
      services_critical: nagiosMeta?.services_critical ?? null,
      services_warning: nagiosMeta?.services_warning ?? null,
      synthetic_excluded: nagiosMeta?.services_synthetic_excluded ?? null,
    },
  };
  // Never present missing monitoring as healthy.
  if (
    nagiosMonitoring.enabled &&
    (nagiosMonitoring.freshness === 'unknown' ||
      nagiosMonitoring.freshness === 'stale' ||
      nagiosMonitoring.freshness === 'monitoring_unavailable' ||
      nagiosMonitoring.adapter_state === 'error' ||
      nagiosMonitoring.adapter_state === 'auth_error' ||
      nagiosMonitoring.adapter_state === 'disabled' ||
      nagiosMonitoring.integration_health === 'auth_failed')
  ) {
    if (nagiosMonitoring.integration_health === 'ok') {
      nagiosMonitoring.integration_health = nagiosMonitoring.freshness || 'unknown';
    }
  }

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
    nagios_monitoring: nagiosMonitoring,
    recent_auth_errors: recentAuthErrors,
  };
}

module.exports = { buildRuntimeStatus, probeNats };
