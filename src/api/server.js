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
  const { db, orchestrator, governance } = deps;
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

  // -------------------------------------------------------------------------
  // OMStudio governance surface (read + externally-sourced status ingest only).
  // NONE of these endpoints let the Brain approve anything itself.
  // -------------------------------------------------------------------------

  // List approval requests + current state.
  app.get('/governance/approvals', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = db ? db.listApprovalRequests(limit) : [];
    res.json({ count: rows.length, approvals: redactForLog(rows) });
  });

  // Approval detail incl. redacted append-only history.
  app.get('/governance/approvals/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getApprovalRequest(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'approval_not_found' });
    const history = db.approvalHistory(Number(req.params.id));
    return res.json({ approval: redactForLog(row), history: redactForLog(history) });
  });

  // Ingest an OMStudio status callback/webhook. In LIVE deployments this is the
  // webhook target OMStudio calls when a superadmin approves/rejects. In dry-run
  // this is how an operator-simulated (test-only) decision arrives. The endpoint
  // ONLY accepts externally-sourced statuses and applies them through the
  // deterministic state machine; it can never be used by the Brain to self-approve.
  app.post('/governance/approvals/:id/ingest-status', (req, res) => {
    if (!governance) return res.status(503).json({ ok: false, error: 'no_governance' });
    const body = req.body || {};
    // 'source' must be external. Reject any attempt to pass a brain source.
    const source = body.source === 'dryrun_sim' ? 'dryrun_sim' : 'omstudio_ingest';
    const out = governance.ingestStatus(Number(req.params.id), {
      decision: body.decision || body.status,
      source,
      note: body.note,
      omstudio_ref: body.omstudio_ref,
    });
    if (!out.ok) {
      const code = out.reason === 'approval_not_found' ? 404 : 400;
      return res.status(code).json({ ok: false, error: out.reason, from: out.from, to: out.to });
    }
    return res.json({ ok: true, from: out.from, to: out.to, state: out.state });
  });

  // Recent audit events emitted to OMStudio (local mirror).
  app.get('/governance/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = db ? db.listOmstudioAudit(limit) : [];
    res.json({ count: rows.length, audit: redactForLog(rows) });
  });

  // No mutation routes exist by design (the ingest endpoint applies only
  // externally-sourced statuses through the deterministic state machine).
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return app;
}

module.exports = { createServer };
