'use strict';

/**
 * Safe LLM circuit status for /health and diagnostics.
 * Never exposes secrets — api_key_present is boolean only.
 */

const http = require('http');
const https = require('https');
const { config } = require('../config');
const breaker = require('../ai/circuitBreaker');

const PROBE_TIMEOUT_MS = 3000;
const PROBE_CACHE_MS = 15000;

let probeCache = { at: 0, result: null };

function apiKeyPresent(cfg) {
  const k = cfg && cfg.apiKey ? String(cfg.apiKey) : '';
  return !!(k && k !== 'local-no-key' && k.trim());
}

function inferProvider(baseUrl) {
  const host = breaker.parseHost(baseUrl || '');
  if (!host) return 'unknown';
  if (host === '127.0.0.1' || host === 'localhost' || String(baseUrl).includes('11434')) {
    return 'ollama';
  }
  return 'openai-compat';
}

function modelsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) return null;
  return `${trimmed}/models`;
}

function probeLlmEndpoint(baseUrl, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const target = modelsUrl(baseUrl);
    if (!target) return resolve({ ok: false, error: 'invalid_base_url' });

    let url;
    try {
      url = new URL(target);
    } catch (_) {
      return resolve({ ok: false, error: 'invalid_base_url' });
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { Accept: 'application/json' } },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'probe_timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message || 'probe_error' }));
  });
}

async function cachedProbe(baseUrl) {
  const nowMs = Date.now();
  if (probeCache.result && nowMs - probeCache.at < PROBE_CACHE_MS) {
    return { probe: probeCache.result, probedAt: probeCache.at };
  }
  const probe = await probeLlmEndpoint(baseUrl);
  probeCache = { at: nowMs, result: probe };
  return { probe, probedAt: nowMs };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.cfg]            config.llm override
 * @param {boolean} [deps.production]
 * @param {string} [deps.memoryBackend]
 * @param {boolean} [deps.skipProbe]     skip network probe (tests)
 * @returns {Promise<object>}
 */
async function buildLlmStatus(deps = {}) {
  const cfg = deps.cfg || config.llm;
  const production = deps.production !== undefined ? deps.production : config.isProduction;
  const memoryBackend = deps.memoryBackend || 'none';
  const baseUrl = cfg.baseUrl || '';

  const base = {
    provider: inferProvider(baseUrl),
    model: cfg.reasoningModel || null,
    api_key_present: apiKeyPresent(cfg),
    memory_backend: memoryBackend,
    last_probe: null,
    last_error: null,
  };

  if (!String(baseUrl).trim()) {
    return { status: 'not_configured', ...base, last_error: 'BRAIN_LLM_BASE_URL not set' };
  }

  const verdict = breaker.checkHost(baseUrl, { production });
  if (!verdict.allowed) {
    return { status: 'disabled', ...base, last_error: verdict.reason };
  }

  if (deps.skipProbe) {
    return { status: 'available', ...base };
  }

  const { probe, probedAt } = await cachedProbe(baseUrl);
  base.last_probe = new Date(probedAt).toISOString();

  if (probe.ok) {
    return { status: 'available', ...base };
  }

  const errSummary = probe.error || `http_${probe.statusCode || 'error'}`;
  const status =
    probe.error === 'probe_timeout' || (probe.statusCode && probe.statusCode >= 500)
      ? 'error'
      : 'degraded';

  return { status, ...base, last_error: errSummary };
}

function resetProbeCache() {
  probeCache = { at: 0, result: null };
}

module.exports = {
  apiKeyPresent,
  inferProvider,
  probeLlmEndpoint,
  buildLlmStatus,
  resetProbeCache,
};
