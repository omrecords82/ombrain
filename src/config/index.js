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
    // 0 = unlimited retries (old behaviour). Default 10 stops the crash loop.
    logWsMaxRetries: num(env.BRAIN_LOG_WS_MAX_RETRIES, 10),
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

  // -------------------------------------------------------------------------
  // Auditor loop (Phase 3) — proactive cron-style platform scanner
  // -------------------------------------------------------------------------
  auditor: {
    // Master switch — set to false to disable the proactive auditor entirely.
    enabled: bool(env.BRAIN_AUDITOR_ENABLED, true),
    // How often the auditor scans the platform (default 5 minutes).
    intervalMs: num(env.BRAIN_AUDITOR_INTERVAL_MS, 5 * 60 * 1000),
  },

  // -------------------------------------------------------------------------
  // Query poll cron job (Phase 10) — polls OMStudio for pending user queries
  // -------------------------------------------------------------------------
  queryPoll: {
    // Master switch — set to false to disable the query poll cron job.
    enabled: bool(env.BRAIN_QUERY_POLL_ENABLED, true),
    // How often the Brain polls OMStudio for pending queries (default 60 s).
    intervalMs: num(env.BRAIN_QUERY_POLL_INTERVAL_MS, 60 * 1000),
    // How often the daily calendar push fires (always midnight UTC — this
    // controls whether the push is enabled at all).
    calendarPushEnabled: bool(env.BRAIN_CALENDAR_PUSH_ENABLED, true),
  },

  // -------------------------------------------------------------------------
  // Self-learning / retrieval-first pipeline (Phase 2)
  // -------------------------------------------------------------------------
  learning: {
    // Master switch — when false the orchestrator always calls the LLM.
    enabled: bool(env.BRAIN_LEARNING_ENABLED, true),
    // Auto-promote low-risk (risk_level=low) informational procedures without
    // human approval. Medium/high/destructive always require human approval.
    autoPromoteLowRisk: bool(env.BRAIN_AUTO_PROMOTE_LOW_RISK, true),
    // Require superadmin approval for ops-class procedures.
    requireApprovalForOps: bool(env.BRAIN_REQUIRE_APPROVAL_FOR_OPS_PROCEDURES, true),
    // When true, skip LLM if a high-confidence local procedure exists.
    llmMinimizationEnabled: bool(env.BRAIN_LLM_MINIMIZATION_ENABLED, true),
    // Procedures not used within this many days are considered stale and
    // trigger an LLM re-check on next use.
    procedureStaleAfterDays: num(env.BRAIN_PROCEDURE_STALE_AFTER_DAYS, 90),
    // Minimum confidence score for a procedure to be used without LLM review.
    procedureMinConfidence: num(env.BRAIN_PROCEDURE_MIN_CONFIDENCE, 0.80),
    // When true, RagRetriever uses BrainAIClient.embed (Ollama nomic-embed-text).
    liveEmbeddingsEnabled: bool(env.BRAIN_LIVE_EMBEDDINGS_ENABLED, true),
    // Number of active corrections for a question_type before the Brain
    // auto-escalates that question_type to requires_human_superadmin.
    stumbleThreshold: num(env.BRAIN_STUMBLE_THRESHOLD, 3),
  },

  // -------------------------------------------------------------------------
  // Theological knowledge layer (§6)
  // -------------------------------------------------------------------------
  theology: {
    // Master switch — when false, POST /brain/theology/ask returns 503.
    enabled: bool(env.BRAIN_THEOLOGY_ENABLED, false),
    // Number of theological_memory chunks retrieved per semantic search.
    topK: num(env.BRAIN_THEOLOGY_TOP_K, 8),
  },

  // -------------------------------------------------------------------------
  // Communication modes router (§8)
  // -------------------------------------------------------------------------
  modes: {
    // Default communication mode when classification yields nothing actionable.
    defaultMode: env.BRAIN_DEFAULT_MODE || 'knowledge',
    // When true, the orchestrator drains the by-the-way (BTW) follow-up queue
    // after answering the primary query.
    btwQueueEnabled: bool(env.BRAIN_BTW_QUEUE_ENABLED, true),
  },

  // -------------------------------------------------------------------------
  // Orthodox calendar engine (§6)
  // -------------------------------------------------------------------------
  calendar: {
    // Deterministic Paschalion/feasts/fasting/saints. No LLM, no network.
    enabled: bool(env.BRAIN_CALENDAR_ENABLED, true),
  },
});

module.exports = { config };
