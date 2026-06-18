'use strict';

/**
 * Brain HTTP API (Spec v1.1 §6).
 *
 * Minimal Express app exposing READ/OBSERVE endpoints only:
 *   GET  /health           — liveness + backend/circuit-breaker posture
 *   GET  /audit/findings   — recent ingested events (redacted)
 *   POST /diagnose         — incident/log context -> analysis + recommendation
 *                            + deterministic governance classification
 *   GET  /decisions        — the append-only decision ledger
 *
 * The Brain's API itself performs NO mutations on OM/OMAI/OMStudio.
 */

const express = require('express');
const { config } = require('../config');
const breaker = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

function createServer(deps = {}) {
  const { db, orchestrator } = deps;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    const verdict = breaker.checkHost(config.llm.baseUrl, { production: config.isProduction });
    res.json({
      ok: true,
      service: 'om-brain',
      phase: 1,
      posture: 'auditor-first (observe, analyze, explain, recommend)',
      executes_actions: false,
      node_env: config.nodeEnv,
      memory_backend: db ? db.backendName() : 'none',
      llm_endpoint_allowed: verdict.allowed,
      llm_endpoint_reason: verdict.reason,
    });
  });

  app.get('/audit/findings', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const events = db ? db.recentEvents(limit) : [];
    res.json({ count: events.length, findings: redactForLog(events) });
  });

  app.post('/diagnose', async (req, res) => {
    try {
      const out = await orchestrator.diagnose({
        sessionId: req.body && req.body.session_id,
        incident: (req.body && req.body.incident) || {},
        proposal: req.body && req.body.proposal,
        context: (req.body && req.body.context) || {},
        workItemRef: req.body && req.body.work_item_ref,
        useModel: !!(req.body && req.body.use_model),
      });
      res.json(redactForLog(out));
    } catch (e) {
      logger.error('diagnose_endpoint_error', { name: e && e.name });
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  app.get('/decisions', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = db ? db.listDecisions(limit) : [];
    res.json({ count: rows.length, decisions: redactForLog(rows) });
  });

  // No mutation routes exist by design.
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return app;
}

module.exports = { createServer };
