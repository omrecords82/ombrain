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

  // -------------------------------------------------------------------------
  // Phase 2 — Task memory
  // -------------------------------------------------------------------------
  app.post('/brain/tasks', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ ok: false, error: 'title_required' });
    const id = b.id || require('crypto').randomUUID();
    db.upsertTask({ id, title: b.title, description: b.description, status: b.status || 'open',
      priority: b.priority || 'normal', assigned_to: b.assigned_to, due_at: b.due_at,
      tags_json: b.tags ? JSON.stringify(b.tags) : null, source: b.source || 'manual', source_ref: b.source_ref });
    return res.status(201).json({ ok: true, id });
  });

  app.get('/brain/tasks', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.listTasks({ status: req.query.status, priority: req.query.priority, limit });
    return res.json({ count: rows.length, tasks: rows });
  });

  app.get('/brain/tasks/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getTask(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'task_not_found' });
    return res.json({ task: row });
  });

  app.patch('/brain/tasks/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const existing = db.getTask(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'task_not_found' });
    const b = req.body || {};
    db.upsertTask({ ...existing, ...b, id: req.params.id,
      tags_json: b.tags ? JSON.stringify(b.tags) : existing.tags_json });
    return res.json({ ok: true, id: req.params.id });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Knowledge memory
  // -------------------------------------------------------------------------
  app.post('/brain/knowledge', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.title || !b.body) return res.status(400).json({ ok: false, error: 'title_and_body_required' });
    const id = b.id || require('crypto').randomUUID();
    const slug = b.slug || b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    db.upsertKnowledge({ id, slug, title: b.title, body: b.body, category: b.category || 'general',
      tags_json: b.tags ? JSON.stringify(b.tags) : null, source_ref: b.source_ref,
      confidence: b.confidence != null ? b.confidence : 1.0 });
    return res.status(201).json({ ok: true, id, slug });
  });

  app.get('/brain/knowledge', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    if (req.query.q) {
      const rows = db.searchKnowledge(req.query.q, { category: req.query.category, limit });
      return res.json({ count: rows.length, results: rows });
    }
    const rows = db.listKnowledge({ category: req.query.category, limit });
    return res.json({ count: rows.length, knowledge: rows });
  });

  app.get('/brain/knowledge/:slug', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getKnowledgeBySlug(req.params.slug);
    if (!row) return res.status(404).json({ ok: false, error: 'knowledge_not_found' });
    return res.json({ knowledge: row });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Procedure memory (self-learning)
  // -------------------------------------------------------------------------
  app.post('/brain/procedures', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.slug || !b.title || !b.procedure_body) return res.status(400).json({ ok: false, error: 'slug_title_body_required' });
    const id = b.id || require('crypto').randomUUID();
    db.upsertProcedure({ id, slug: b.slug, title: b.title, intent_key: b.intent_key || b.slug,
      mode: b.mode || 'knowledge', trigger_examples: b.trigger_examples ? JSON.stringify(b.trigger_examples) : null,
      procedure_body: b.procedure_body, commands_json: b.commands ? JSON.stringify(b.commands) : null,
      required_permissions: b.required_permissions ? JSON.stringify(b.required_permissions) : null,
      risk_level: b.risk_level || 'low', validation_steps: b.validation_steps ? JSON.stringify(b.validation_steps) : null,
      source_decision_id: b.source_decision_id, source_type: b.source_type || 'manual',
      confidence: b.confidence != null ? b.confidence : 0.0, approved: b.approved ? 1 : 0,
      usage_count: 0 });
    return res.status(201).json({ ok: true, id, slug: b.slug });
  });

  app.get('/brain/procedures', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const approved = req.query.approved != null ? req.query.approved === 'true' : undefined;
    const rows = db.listProcedures({ approved, risk_level: req.query.risk_level, limit });
    return res.json({ count: rows.length, procedures: rows });
  });

  app.get('/brain/procedures/:slug', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getProcedureBySlug(req.params.slug);
    if (!row) return res.status(404).json({ ok: false, error: 'procedure_not_found' });
    return res.json({ procedure: row });
  });

  app.post('/brain/procedures/:slug/approve', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getProcedureBySlug(req.params.slug);
    if (!row) return res.status(404).json({ ok: false, error: 'procedure_not_found' });
    const approved_by = (req.body && req.body.approved_by) || 'operator';
    db.approveProcedure(row.id, { approved_by });
    return res.json({ ok: true, slug: req.params.slug, approved_by });
  });

  app.post('/brain/procedures/:slug/reject', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getProcedureBySlug(req.params.slug);
    if (!row) return res.status(404).json({ ok: false, error: 'procedure_not_found' });
    const rejected_by = (req.body && req.body.rejected_by) || 'operator';
    db.rejectProcedure(row.id, { rejected_by });
    return res.json({ ok: true, slug: req.params.slug, rejected_by });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Correction memory (append-only)
  // -------------------------------------------------------------------------
  app.post('/brain/corrections', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.correction_type || !b.wrong_answer || !b.correct_answer || !b.submitted_by)
      return res.status(400).json({ ok: false, error: 'correction_type_wrong_correct_submitted_by_required' });
    const id = b.id || require('crypto').randomUUID();
    db.appendCorrection({ id, decision_id: b.decision_id, procedure_id: b.procedure_id,
      correction_type: b.correction_type, wrong_answer: b.wrong_answer, correct_answer: b.correct_answer,
      explanation: b.explanation, submitted_by: b.submitted_by,
      tags_json: b.tags ? JSON.stringify(b.tags) : null });
    return res.status(201).json({ ok: true, id });
  });

  app.get('/brain/corrections', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.listCorrections({ correction_type: req.query.correction_type, limit });
    return res.json({ count: rows.length, corrections: rows });
  });

  // Also expose /brain/feedback as a friendly alias for POST /brain/corrections
  app.post('/brain/feedback', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.decision_id && !b.message) return res.status(400).json({ ok: false, error: 'decision_id_or_message_required' });
    const id = require('crypto').randomUUID();
    db.appendCorrection({ id, decision_id: b.decision_id, correction_type: b.correction_type || 'operator_override',
      wrong_answer: b.wrong_answer || '(not specified)', correct_answer: b.correct_answer || b.message,
      explanation: b.explanation, submitted_by: b.submitted_by || 'operator' });
    return res.status(201).json({ ok: true, id });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Theological memory (read-only after seed)
  // -------------------------------------------------------------------------
  app.get('/brain/theology', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!req.query.q) return res.status(400).json({ ok: false, error: 'q_required' });
    const rows = db.searchTheology(req.query.q, { category: req.query.category, limit });
    return res.json({ count: rows.length, results: rows });
  });

  app.get('/brain/theology/:reference_key', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getTheologyByRef(req.params.reference_key);
    if (!row) return res.status(404).json({ ok: false, error: 'reference_not_found' });
    return res.json({ entry: row });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Church memory
  // -------------------------------------------------------------------------
  app.get('/brain/churches', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.searchChurches({ city: req.query.city, state: req.query.state,
      jurisdiction: req.query.jurisdiction, limit });
    return res.json({ count: rows.length, churches: rows });
  });

  app.post('/brain/churches', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.name || !b.source) return res.status(400).json({ ok: false, error: 'name_and_source_required' });
    const id = b.id || require('crypto').randomUUID();
    db.upsertChurch({ id, place_id: b.place_id, name: b.name, jurisdiction: b.jurisdiction,
      address: b.address, city: b.city, state: b.state, country: b.country || 'US',
      lat: b.lat, lng: b.lng, phone: b.phone, website: b.website,
      liturgical_calendar: b.liturgical_calendar, source: b.source, last_verified: b.last_verified });
    return res.status(201).json({ ok: true, id });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — BTW queue
  // -------------------------------------------------------------------------
  app.get('/brain/btw', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const rows = db.pendingBtw();
    return res.json({ count: rows.length, items: rows });
  });

  app.post('/brain/btw', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.message) return res.status(400).json({ ok: false, error: 'message_required' });
    const id = b.id || require('crypto').randomUUID();
    db.enqueueBtw({ id, message: b.message, category: b.category, priority: b.priority,
      delivery_mode: b.delivery_mode, deliver_at: b.deliver_at, source_ref: b.source_ref });
    return res.status(201).json({ ok: true, id });
  });

  app.post('/brain/btw/:id/delivered', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    db.markBtwDelivered(req.params.id);
    return res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Health update (report phase 2 is live)
  // -------------------------------------------------------------------------

  // No mutation routes exist by design (the ingest endpoint applies only
  // externally-sourced statuses through the deterministic state machine).
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return app;
}

module.exports = { createServer };
