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
const num  = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = Object.freeze({
  nodeEnv:      env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',

  http: {
    host: env.BRAIN_HTTP_HOST || '127.0.0.1',
    port: num(env.BRAIN_HTTP_PORT, 8390),
  },

  llm: {
    baseUrl:         env.BRAIN_LLM_BASE_URL || 'http://127.0.0.1:11434/v1',
    apiKey:          env.BRAIN_LLM_API_KEY  || 'local-no-key',
    reasoningModel:  env.BRAIN_LLM_REASONING_MODEL  || 'qwen2.5:7b-instruct-q4_K_M',
    classifierModel: env.BRAIN_LLM_CLASSIFIER_MODEL || 'qwen2.5:3b-instruct-q4_K_M',
    embeddingModel:  env.BRAIN_LLM_EMBEDDING_MODEL  || 'nomic-embed-text',
    timeoutMs:       num(env.BRAIN_LLM_TIMEOUT_MS, 180000),
  },

  ingest: {
    apiBaseUrl:           env.OM_API_BASE_URL || 'https://orthodoxmetrics.com',
    jwtVarName:           'BRAIN_OPS_JWT',
    jwt:                  env.BRAIN_OPS_JWT || '',
    eventsPath:           env.BRAIN_EVENTS_PATH      || '/api/platform/events',
    deployRunsPath:       env.BRAIN_DEPLOY_RUNS_PATH || '/api/deploy-runs',
    eventsPollMs:         num(env.BRAIN_EVENTS_POLL_MS, 30000),
    inventoryPath:        env.BRAIN_INVENTORY_PATH   || '/api/platform/inventory',
    inventoryFresh:       env.BRAIN_INVENTORY_FRESH  || '1',
    inventoryPollMs:      num(env.BRAIN_INVENTORY_POLL_MS, 60000),
    logWsUrl:             env.BRAIN_LOG_WS_URL        || 'wss://orthodoxmetrics.com/ws/omai-logger',
    logWsBackoffMs:       num(env.BRAIN_LOG_WS_BACKOFF_MS, 2000),
    logWsBackoffMaxMs:    num(env.BRAIN_LOG_WS_BACKOFF_MAX_MS, 60000),
    logWsMaxRetries:      num(env.BRAIN_LOG_WS_MAX_RETRIES, 10),
    enableEventAdapter:     bool(env.BRAIN_ENABLE_EVENT_ADAPTER,     false),
    enableInventoryAdapter: bool(env.BRAIN_ENABLE_INVENTORY_ADAPTER, false),
    enableLogAdapter:       bool(env.BRAIN_ENABLE_LOG_ADAPTER,       false),
  },

  memory: {
    dbPath:       env.BRAIN_DB_PATH        || './data/brain.db',
    doctrinePath: env.BRAIN_DOCTRINE_PATH  || './src/doctrine/om-doctrine-0001.md',
    embeddingDim: num(env.BRAIN_EMBEDDING_DIM, 768),
  },

  omstudio: {
    governanceBaseUrl:
      env.OMSTUDIO_GOVERNANCE_BASE_URL || 'https://omstudio.orthodoxmetrics.com/omstudio-embed',
    serviceTokenVarName: 'OMSTUDIO_SERVICE_TOKEN',
    serviceToken:        env.OMSTUDIO_SERVICE_TOKEN || '',
    transport:           (env.OMSTUDIO_TRANSPORT || 'dryrun').toLowerCase() === 'http' ? 'http' : 'dryrun',
    outboxDir:           env.OMSTUDIO_OUTBOX_DIR || './data/omstudio-outbox',
  },

  // -------------------------------------------------------------------------
  // Auditor loop (Phase 3) — proactive cron-style platform scanner
  // -------------------------------------------------------------------------
  auditor: {
    enabled:    bool(env.BRAIN_AUDITOR_ENABLED, true),
    intervalMs: num(env.BRAIN_AUDITOR_INTERVAL_MS, 5 * 60 * 1000),
  },

  // -------------------------------------------------------------------------
  // Query poll cron job (Phase 10) — polls OMStudio for pending user queries
  // -------------------------------------------------------------------------
  queryPoll: {
    enabled:             bool(env.BRAIN_QUERY_POLL_ENABLED, true),
    intervalMs:          num(env.BRAIN_QUERY_POLL_INTERVAL_MS, 60 * 1000),
    calendarPushEnabled: bool(env.BRAIN_CALENDAR_PUSH_ENABLED, true),
  },

  // -------------------------------------------------------------------------
  // Self-learning / retrieval-first pipeline (Phase 2)
  // -------------------------------------------------------------------------
  learning: {
    enabled:                  bool(env.BRAIN_LEARNING_ENABLED, true),
    autoPromoteLowRisk:       bool(env.BRAIN_AUTO_PROMOTE_LOW_RISK, true),
    requireApprovalForOps:    bool(env.BRAIN_REQUIRE_APPROVAL_FOR_OPS_PROCEDURES, true),
    llmMinimizationEnabled:   bool(env.BRAIN_LLM_MINIMIZATION_ENABLED, true),
    procedureStaleAfterDays:  num(env.BRAIN_PROCEDURE_STALE_AFTER_DAYS, 90),
    procedureMinConfidence:   num(env.BRAIN_PROCEDURE_MIN_CONFIDENCE, 0.80),
  },

  theology: {
    enabled: bool(env.BRAIN_THEOLOGY_ENABLED, false),
    topK:    num(env.BRAIN_THEOLOGY_TOP_K, 8),
  },
});

module.exports = { config };
