'use strict';

/**
 * Central config module.
 *
 * Reads governed ecosystem configuration from environment variables with sane
 * defaults. Per OM-DOCTRINE-0001 / Spec v1.1 Annex A §G, these variables are
 * governed and subject to OMStudio audit. This module performs a tiny, no-
 * dependency .env loader so the repo runs without external packages.
 *
 * NOTHING here ever logs secret values.
 */

const fs = require('fs');
const path = require('path');

// --- minimal .env loader (no dependency) -----------------------------------
function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // no .env file is fine — defaults below apply
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = Object.freeze({
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',

  http: {
    host: env.BRAIN_HTTP_HOST || '127.0.0.1',
    port: num(env.BRAIN_HTTP_PORT, 8390),
  },

  llm: {
    baseUrl: env.BRAIN_LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
    apiKey: env.BRAIN_LLM_API_KEY || 'local-no-key',
    reasoningModel: env.BRAIN_LLM_REASONING_MODEL || 'qwen2.5:7b-instruct-q4_K_M',
    classifierModel: env.BRAIN_LLM_CLASSIFIER_MODEL || 'qwen2.5:3b-instruct-q4_K_M',
    embeddingModel: env.BRAIN_LLM_EMBEDDING_MODEL || 'nomic-embed-text',
    timeoutMs: num(env.BRAIN_LLM_TIMEOUT_MS, 60000),
  },

  ingest: {
    apiBaseUrl: env.OM_API_BASE_URL || 'https://orthodoxmetrics.com',
    // The NAME of the env var holding the JWT — documented, never hardcoded.
    jwtVarName: 'BRAIN_OPS_JWT',
    jwt: env.BRAIN_OPS_JWT || '',
    eventsPath: env.BRAIN_EVENTS_PATH || '/api/platform/events',
    deployRunsPath: env.BRAIN_DEPLOY_RUNS_PATH || '/api/deploy-runs',
    eventsPollMs: num(env.BRAIN_EVENTS_POLL_MS, 30000),
    inventoryPath: env.BRAIN_INVENTORY_PATH || '/api/platform/inventory',
    inventoryFresh: env.BRAIN_INVENTORY_FRESH || '1',
    inventoryPollMs: num(env.BRAIN_INVENTORY_POLL_MS, 60000),
    logWsUrl: env.BRAIN_LOG_WS_URL || 'wss://orthodoxmetrics.com/ws/omai-logger',
    logWsBackoffMs: num(env.BRAIN_LOG_WS_BACKOFF_MS, 2000),
    logWsBackoffMaxMs: num(env.BRAIN_LOG_WS_BACKOFF_MAX_MS, 60000),
    enableEventAdapter: bool(env.BRAIN_ENABLE_EVENT_ADAPTER, false),
    enableInventoryAdapter: bool(env.BRAIN_ENABLE_INVENTORY_ADAPTER, false),
    enableLogAdapter: bool(env.BRAIN_ENABLE_LOG_ADAPTER, false),
  },

  memory: {
    dbPath: env.BRAIN_DB_PATH || './data/brain.db',
    doctrinePath: env.BRAIN_DOCTRINE_PATH || './src/doctrine/om-doctrine-0001.md',
    embeddingDim: num(env.BRAIN_EMBEDDING_DIM, 768),
  },

  omstudio: {
    // Governed ecosystem config (Annex A §G). The base URL targets the .242
    // OMStudio edge / omstudio-embed front — NOT an internal port. Placeholder
    // default; the team must confirm the live governance route.
    governanceBaseUrl:
      env.OMSTUDIO_GOVERNANCE_BASE_URL || 'https://omstudio.orthodoxmetrics.com/omstudio-embed',
    // The NAME of the service-token env var is documented; the VALUE is on the
    // never-log list and must never be logged/emitted.
    serviceTokenVarName: 'OMSTUDIO_SERVICE_TOKEN',
    serviceToken: env.OMSTUDIO_SERVICE_TOKEN || '',
    // 'dryrun' (default, offline outbox) | 'http' (live; ASSUMED contract).
    transport: (env.OMSTUDIO_TRANSPORT || 'dryrun').toLowerCase() === 'http' ? 'http' : 'dryrun',
    outboxDir: env.OMSTUDIO_OUTBOX_DIR || './data/omstudio-outbox',
  },
});

module.exports = { config };
