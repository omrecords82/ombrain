'use strict';

/**
 * Brain HTTP API (Spec v1.1 §6).
 *
 * PATCH P0-1 / P0-3 (2026-06-27):
 *   - Added /brain/calendar/* routes (P0-1):
 *       GET  /brain/calendar/pascha/:year
 *       GET  /brain/calendar/feasts/:year
 *       GET  /brain/calendar/fasting        ?date=YYYY-MM-DD (defaults to today)
 *       GET  /brain/calendar/season         ?date=YYYY-MM-DD (defaults to today)
 *       GET  /brain/calendar/year/:year     full Paschalion + feasts + fasting
 *       GET  /brain/calendar/range          ?start=&end= per-day fasting + saints
 *   - Added POST /brain/ask (P0-3):
 *       Unified query entry-point that routes through orchestrator.ask().
 *       Replaces the cron-only query-poll path with a synchronous HTTP surface.
 *   - All existing routes are unchanged from commit d681340.
 */

const express = require('express');
const { config } = require('../config');
const breaker = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');
const { validateWebhookSecret } = require('../governance/omstudioClient');

// ---------------------------------------------------------------------------
// Calendar helpers (loaded lazily to avoid startup errors if module is absent)
// ---------------------------------------------------------------------------

function loadCalendar() {
  try {
    return require('../calendar/index');
  } catch (e) {
    return null;
  }
}

/**
 * Determine the current liturgical season name for a given date.
 * Purely deterministic — no LLM call.
 *
 * @param {Date} date
 * @param {object} cal - calendar module
 * @returns {string}
 */
function getLiturgicalSeason(date, cal) {
  const year = date.getUTCFullYear();
  const t = date.getTime();
  const m = cal.getMoveableFeasts(year);

  if (t >= m.cleanMonday.getTime() && t < m.lazarusSaturday.getTime()) return 'Great Lent';
  if (t >= m.lazarusSaturday.getTime() && t < m.pascha.getTime()) return 'Holy Week';
  if (t >= m.pascha.getTime() && t < m.thomasSunday.getTime()) return 'Bright Week';
  if (t >= m.thomasSunday.getTime() && t < m.pentecost.getTime()) return 'Pentecostarion';
  if (t >= m.pentecost.getTime() && t < m.allSaints.getTime()) return 'Trinity Week (Fast-Free)';
  if (t > m.allSaints.getTime() && t <= new Date(Date.UTC(year, 5, 28)).getTime()) return "Apostles' Fast";

  const mo = date.getUTCMonth();
  const dy = date.getUTCDate();
  if (mo === 7 && dy >= 1 && dy <= 14) return 'Dormition Fast';
  if ((mo === 10 && dy >= 15) || (mo === 11 && dy <= 24)) return 'Nativity Fast';
  if ((mo === 11 && dy >= 25) || (mo === 0 && dy <= 4)) return 'Christmastide (Fast-Free)';
  if (t >= m.publicanAndPharisee.getTime() && t < m.prodigalSon.getTime()) {
    return 'Publican and Pharisee Week (Fast-Free)';
  }
  if (t > m.meatfareSunday.getTime() && t <= m.cheesefareSunday.getTime()) return 'Cheesefare Week';

  return 'Ordinary Time';
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function createServer(deps = {}) {
  const { db, orchestrator, governance, churchFinder, ragRetriever } = deps;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------

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
  // OMStudio governance surface
  // -------------------------------------------------------------------------

  app.get('/governance/approvals', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = db ? db.listApprovalRequests(limit) : [];
    res.json({ count: rows.length, approvals: redactForLog(rows) });
  });

  app.get('/governance/approvals/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const row = db.getApprovalRequest(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'approval_not_found' });
    const history = db.approvalHistory(Number(req.params.id));
    return res.json({ approval: redactForLog(row), history: redactForLog(history) });
  });

  app.get('/governance/approvals/:id/history', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const id = Number(req.params.id);
    const row = db.getApprovalRequest(id);
    if (!row) return res.status(404).json({ ok: false, error: 'approval_not_found' });
    const history = db.approvalHistory(id);
    return res.json({ approval_id: id, count: history.length, history: redactForLog(history) });
  });

  app.post('/governance/approvals/:id/ingest-status', (req, res) => {
    if (!governance) return res.status(503).json({ ok: false, error: 'no_governance' });

    const webhookSecret = process.env.OMSTUDIO_WEBHOOK_SECRET || '';
    const secretCheck = validateWebhookSecret(
      req.headers['x-om-webhook-secret'] || '',
      webhookSecret,
    );
    if (!secretCheck.ok) {
      logger.warn('ingest_status_webhook_secret_rejected', {
        reason: secretCheck.reason,
        approval_id: req.params.id,
      });
      return res.status(401).json({ ok: false, error: secretCheck.reason });
    }

    const body = req.body || {};
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
    logger.info('ingest_status_applied', {
      approval_id: req.params.id,
      from: out.from,
      to: out.to,
      source,
    });
    return res.json({ ok: true, from: out.from, to: out.to, state: out.state });
  });

  app.get('/governance/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = db ? db.listOmstudioAudit(limit) : [];
    res.json({ count: rows.length, audit: redactForLog(rows) });
  });

  app.get('/governance/health', (req, res) => {
    const omstudioBaseUrl = config.omstudio ? config.omstudio.governanceBaseUrl : '';
    const verdict = omstudioBaseUrl
      ? breaker.checkHost(omstudioBaseUrl, { production: config.isProduction })
      : { allowed: false, reason: 'no_base_url_configured' };
    const webhookSecretConfigured = !!(process.env.OMSTUDIO_WEBHOOK_SECRET || '');
    res.json({
      ok: true,
      transport: (config.omstudio && config.omstudio.transport) || 'dryrun',
      omstudio_base_url_allowed: verdict.allowed,
      omstudio_base_url_reason: verdict.reason,
      webhook_secret_configured: webhookSecretConfigured,
      outbox_dir: (config.omstudio && config.omstudio.outboxDir) || './data/omstudio-outbox',
    });
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

  app.post('/brain/knowledge/search', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.q) return res.status(400).json({ ok: false, error: 'q_required' });
    const limit = Math.min(Number(b.limit) || 20, 200);
    const rows = db.searchKnowledge(b.q, { category: b.category, limit });
    return res.json({ count: rows.length, results: rows });
  });

  // -------------------------------------------------------------------------
  // Phase 2 — Procedure memory
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
  // Phase 2 — Correction memory
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
      liturgical_calendar: b.liturgical_calendar, source: b.source, last_verified: b.last_verified,
      google_maps_url: b.google_maps_url, rating: b.rating, rating_count: b.rating_count,
      canonical: b.canonical, service_schedule_json: b.service_schedule_json,
      opening_hours_json: b.opening_hours_json, hours_source: b.hours_source,
      last_fetched_at: b.last_fetched_at, zip: b.zip });
    return res.status(201).json({ ok: true, id });
  });

  app.get('/brain/churches/jurisdictions', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const jurisdictions = typeof db.listChurchJurisdictions === 'function'
      ? db.listChurchJurisdictions()
      : [];
    return res.json({ count: jurisdictions.length, jurisdictions });
  });

  app.post('/brain/churches/find', async (req, res) => {
    if (!churchFinder) {
      return res.status(503).json({ ok: false, error: 'church_finder_not_configured' });
    }
    const b = req.body || {};
    try {
      let result;
      if (b.lat != null && b.lng != null) {
        result = await churchFinder.searchNearby({
          lat: Number(b.lat),
          lng: Number(b.lng),
          radiusMiles: Number(b.radius_miles) || 25,
          limit: Math.min(Number(b.limit) || 10, 50),
        });
      } else if (b.zip || b.query) {
        result = await churchFinder.findChurches({
          input: b.zip || b.query,
          radiusMiles: Number(b.radius_miles) || 25,
        });
      } else {
        return res.status(400).json({ ok: false, error: 'lat_lng_or_zip_or_query_required' });
      }
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'church_finder_error', detail: err && err.message });
    }
  });

  app.get('/brain/churches/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    if (req.params.id === 'jurisdictions') {
      return res.redirect(307, '/brain/churches/jurisdictions');
    }
    let row = typeof db.churchByPlaceId === 'function'
      ? db.churchByPlaceId(req.params.id)
      : null;
    if (!row) {
      const all = db.searchChurches({ limit: 5000 });
      row = all.find((r) => r.id === req.params.id) || null;
    }
    if (!row) return res.status(404).json({ ok: false, error: 'church_not_found' });
    return res.json({ church: row });
  });

  app.post('/brain/churches/:id/enrich', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    if (typeof db.enrichChurch !== 'function') {
      return res.status(503).json({ ok: false, error: 'enrichChurch_not_available' });
    }
    const b = req.body || {};
    db.enrichChurch(req.params.id, {
      jurisdiction: b.jurisdiction,
      liturgical_calendar: b.liturgical_calendar,
      canonical: b.canonical,
      service_schedule_json: b.service_schedule_json
        ? (typeof b.service_schedule_json === 'string' ? b.service_schedule_json : JSON.stringify(b.service_schedule_json))
        : null,
    });
    return res.json({ ok: true, place_id: req.params.id });
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

  app.post('/brain/btw/session', (req, res) => {
    if (!orchestrator || !orchestrator.btwQueue) {
      return res.status(503).json({ ok: false, error: 'btw_queue_not_configured' });
    }
    const b = req.body || {};
    if (!b.session_id || !b.question) {
      return res.status(400).json({ ok: false, error: 'session_id_and_question_required' });
    }
    const result = orchestrator.btwQueue.enqueue({
      session_id: b.session_id,
      question: b.question,
      mode: b.mode,
    });
    return res.status(result.ok ? 201 : 400).json(result);
  });

  app.get('/brain/btw/session/:session_id', (req, res) => {
    if (!orchestrator || !orchestrator.btwQueue) {
      return res.status(503).json({ ok: false, error: 'btw_queue_not_configured' });
    }
    const history = orchestrator.btwQueue.history(req.params.session_id);
    return res.json({ count: history.length, items: history });
  });

  // -------------------------------------------------------------------------
  // §5 — Correction memory: full feedback REST surface
  // -------------------------------------------------------------------------

  app.get('/brain/feedback', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.listCorrections({ limit });
    const active = rows.filter((r) => r.active !== 0);
    return res.json({ count: active.length, corrections: active });
  });

  app.get('/brain/feedback/:decision_id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const rows = db.correctionsForDecision(req.params.decision_id);
    return res.json({ count: rows.length, corrections: rows });
  });

  app.patch('/brain/feedback/:id', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.correction) return res.status(400).json({ ok: false, error: 'correction_required' });
    const newId = db.reviseCorrection(req.params.id, { correction: b.correction, verdict: b.verdict });
    if (!newId) return res.status(404).json({ ok: false, error: 'correction_not_found' });
    return res.json({ ok: true, original_id: req.params.id, new_id: newId });
  });

  app.get('/brain/feedback/patterns', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const { config } = require('../config');
    const threshold = config.learning.stumbleThreshold || 3;
    const questionTypes = [
      'service_restart_recommendation', 'cross_tenant_detection',
      'schema_change_governance', 'never_auto_action', 'informational', 'other',
    ];
    const patterns = questionTypes
      .map((qt) => {
        const rows = db.correctionsByQuestionType(qt);
        return { question_type: qt, correction_count: rows.length, exceeds_threshold: rows.length >= threshold };
      })
      .filter((p) => p.correction_count > 0);
    return res.json({ threshold, patterns });
  });

  // -------------------------------------------------------------------------
  // §6 — Theological knowledge layer: RAG + scripture lookup
  // -------------------------------------------------------------------------

  app.post('/brain/theology/ask', async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const b = req.body || {};
    if (!b.question) return res.status(400).json({ ok: false, error: 'question_required' });
    const { config } = require('../config');
    if (!config.theology || !config.theology.enabled) {
      return res.status(503).json({ ok: false, error: 'theology_disabled', hint: 'Set BRAIN_THEOLOGY_ENABLED=true' });
    }
    const topK = config.theology.topK || 8;
    let chunks = [];
    try {
      if (ragRetriever && db && typeof db.listTheology === 'function') {
        const rows = db.listTheology({ limit: 500 });
        const ranked = await ragRetriever.retrieve(b.question, rows, { k: topK, textField: 'body' });
        chunks = ranked.map((r) => ({ ...r.meta, body: r.text, _rag_score: r.score }));
      }
      if (chunks.length === 0) {
        chunks = db.searchTheology(b.question, { limit: topK });
      }
    } catch (e) {
      logger.warn('theology_ask_rag_error', { name: e && e.name });
      chunks = db.searchTheology(b.question, { limit: topK });
    }
    const citations = chunks.map((c) => ({
      source_ref: c.source_ref || c.reference_key,
      source: c.source,
      category: c.category,
      body: c.body.slice(0, 400),
    }));
    let answer = null;
    if (orchestrator && orchestrator.ai) {
      try {
        const context = chunks.map((c) => `[${c.source_ref || c.reference_key}] ${c.body}`).join('\n\n');
        const prompt = `You are an Orthodox Christian theological assistant. Answer the following question using ONLY the provided sources. Always cite your sources. If the Fathers are not unanimous on a topic, note that explicitly.\n\nQuestion: ${b.question}\n\nSources:\n${context}`;
        const adv = await orchestrator.ai.complete({ prompt, sessionId: b.session_id || 'theology-' + Date.now() });
        if (adv && adv.ok) answer = adv.content;
      } catch (_) {}
    }
    return res.json({
      ok: true,
      question: b.question,
      answer: answer || '(AI client not available — see citations below)',
      citations,
      source_count: citations.length,
    });
  });

  app.get('/brain/theology/scripture', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    let book = req.query.book;
    let chapter = req.query.chapter ? Number(req.query.chapter) : null;
    let verseStart = req.query.verse ? Number(req.query.verse) : null;
    let verseEnd = req.query.verse_end ? Number(req.query.verse_end) : verseStart;
    if (req.query.ref) {
      const m = String(req.query.ref).match(/^([A-Za-z0-9 ]+)\+(\d+):(\d+)(?:-(\d+))?$/);
      if (m) { book = m[1]; chapter = Number(m[2]); verseStart = Number(m[3]); verseEnd = m[4] ? Number(m[4]) : verseStart; }
    }
    if (!book || !chapter) return res.status(400).json({ ok: false, error: 'book_and_chapter_required' });
    const verses = db.scriptureByRef(book, chapter, verseStart, verseEnd);
    return res.json({ book, chapter, verse_start: verseStart, verse_end: verseEnd, count: verses.length, verses });
  });

  app.get('/brain/theology/topics', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const topics = db.theologyTopics();
    return res.json({ count: topics.length, topics });
  });

  app.get('/brain/theology/sources', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'no_db' });
    const sources = db.theologySources();
    return res.json({ count: sources.length, sources });
  });

  // -------------------------------------------------------------------------
  // P0-1 — Calendar API routes (§7)
  //
  // All routes are deterministic (no LLM). They load the calendar module
  // lazily so the server still starts if the module is somehow absent.
  // -------------------------------------------------------------------------

  /**
   * GET /brain/calendar/pascha/:year
   * Returns the Gregorian date of Orthodox Pascha for the given year.
   *
   * Response: { year, pascha: "YYYY-MM-DD", pascha_display: "Day, Month DD YYYY" }
   */
  app.get('/brain/calendar/pascha/:year', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });

    const year = parseInt(req.params.year, 10);
    if (isNaN(year) || year < 1900 || year > 2200) {
      return res.status(400).json({ ok: false, error: 'year_out_of_range', hint: '1900–2200' });
    }

    const pascha = cal.getPascha(year);
    return res.json({
      ok: true,
      year,
      pascha: pascha.toISOString().slice(0, 10),
      pascha_display: pascha.toDateString(),
      calendar: 'new_calendar_gregorian_civil_date',
      note: 'Date is the Gregorian civil date on which Orthodox Pascha falls (Julian Paschalion, Meeus algorithm).',
    });
  });

  /**
   * GET /brain/calendar/feasts/:year
   * Returns all moveable and fixed Great Feasts for the given year.
   *
   * Response: { year, moveable_feasts: [{name, date}], fixed_feasts: [{name, date}] }
   */
  app.get('/brain/calendar/feasts/:year', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });

    const year = parseInt(req.params.year, 10);
    if (isNaN(year) || year < 1900 || year > 2200) {
      return res.status(400).json({ ok: false, error: 'year_out_of_range', hint: '1900–2200' });
    }

    const moveableObj = cal.getMoveableFeasts(year);
    const fixedObj    = cal.getFixedFeasts(year);

    const moveableFeasts = Object.entries(moveableObj).map(([name, date]) => ({
      name,
      date: date instanceof Date ? date.toISOString().slice(0, 10) : String(date),
    }));
    const fixedFeasts = Object.entries(fixedObj).map(([name, date]) => ({
      name,
      date: date instanceof Date ? date.toISOString().slice(0, 10) : String(date),
    }));

    return res.json({
      ok: true,
      year,
      moveable_count: moveableFeasts.length,
      fixed_count: fixedFeasts.length,
      moveable_feasts: moveableFeasts,
      fixed_feasts: fixedFeasts,
    });
  });

  /**
   * GET /brain/calendar/fasting?date=YYYY-MM-DD
   * Returns the fasting rule for a given date (defaults to today UTC).
   *
   * Response: { date, level, reason }
   */
  app.get('/brain/calendar/fasting', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });

    let date;
    if (req.query.date) {
      date = new Date(req.query.date + 'T12:00:00Z');
      if (isNaN(date.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid_date', hint: 'YYYY-MM-DD' });
      }
    } else {
      date = new Date();
    }

    const rule = cal.getFastingRule(date);
    return res.json({
      ok: true,
      date: date.toISOString().slice(0, 10),
      level: rule.level,
      reason: rule.reason,
    });
  });

  /**
   * GET /brain/calendar/season?date=YYYY-MM-DD
   * Returns the liturgical season name for a given date (defaults to today UTC).
   *
   * Response: { date, season }
   */
  app.get('/brain/calendar/season', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });

    let date;
    if (req.query.date) {
      date = new Date(req.query.date + 'T12:00:00Z');
      if (isNaN(date.getTime())) {
        return res.status(400).json({ ok: false, error: 'invalid_date', hint: 'YYYY-MM-DD' });
      }
    } else {
      date = new Date();
    }

    const season = getLiturgicalSeason(date, cal);
    return res.json({
      ok: true,
      date: date.toISOString().slice(0, 10),
      season,
    });
  });

  /**
   * GET /brain/calendar/saints?month=8&day=6&calendar=old&year=2026
   * Returns the saints commemorated on a specific date. `calendar` is 'old'
   * (interpret month/day as the Julian O.S. date, default) or 'new' (interpret
   * as the Gregorian civil N.S. date). Deterministic — no LLM.
   *
   * Response: { date, calendar, year, count, saints: [...] }
   */
  app.get('/brain/calendar/saints', (req, res) => {
    const cal = loadCalendar();
    if (!cal || typeof cal.saintsForDate !== 'function') {
      return res.status(503).json({ ok: false, error: 'saints_engine_unavailable' });
    }
    const month = parseInt(req.query.month, 10);
    const day = parseInt(req.query.day, 10);
    if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
      return res.status(400).json({ ok: false, error: 'month_and_day_required', hint: 'month=1-12 & day=1-31' });
    }
    const calendar = req.query.calendar === 'new' ? 'new' : 'old';
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
    const saints = cal.saintsForDate(month, day, calendar, year);
    return res.json({
      ok: true,
      date: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      calendar,
      year,
      count: saints.length,
      saints,
    });
  });

  /**
   * GET /brain/calendar/today?calendar=old
   * Today's season, fasting rule, and saints (server date, UTC).
   * The civil server date is treated as the New-Style date; we report the
   * saints commemorated on that N.S. date plus the active fasting rule.
   *
   * Response: { date, season, fasting, saints }
   */
  app.get('/brain/calendar/today', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const year = now.getUTCFullYear();
    const season = getLiturgicalSeason(now, cal);
    const fasting = typeof cal.getFastingRule === 'function' ? cal.getFastingRule(now) : null;
    const saints = typeof cal.saintsForDate === 'function'
      ? cal.saintsForDate(month, day, 'new', year)
      : [];
    return res.json({
      ok: true,
      date: now.toISOString().slice(0, 10),
      season,
      fasting,
      saint_count: saints.length,
      saints,
    });
  });

  /**
   * GET /brain/calendar/year/:year
   * Full Paschalion record (Orthodox + Western Easter + cycles) plus moveable
   * feasts, fixed feasts, and the year's fasting periods. Deterministic.
   */
  app.get('/brain/calendar/year/:year', (req, res) => {
    const cal = loadCalendar();
    if (!cal || typeof cal.calendarForYear !== 'function') {
      return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });
    }
    const year = parseInt(req.params.year, 10);
    if (isNaN(year) || year < 1900 || year > 2200) {
      return res.status(400).json({ ok: false, error: 'year_out_of_range', hint: '1900–2200' });
    }
    const out = cal.calendarForYear(year, req.query.calendar || 'new');
    if (typeof cal.fastingCalendar === 'function') {
      out.fasting = cal.fastingCalendar(year);
    }
    return res.json({ ok: true, ...out });
  });

  /**
   * GET /brain/calendar/range?start=YYYY-MM-DD&end=YYYY-MM-DD
   * Per-day fasting rule (+ saints if the saints engine is present) across an
   * inclusive date range, capped at 366 days.
   */
  app.get('/brain/calendar/range', (req, res) => {
    const cal = loadCalendar();
    if (!cal) return res.status(503).json({ ok: false, error: 'calendar_module_unavailable' });
    const start = new Date(String(req.query.start) + 'T12:00:00Z');
    const end = new Date(String(req.query.end) + 'T12:00:00Z');
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ ok: false, error: 'invalid_range', hint: 'start & end as YYYY-MM-DD' });
    }
    if (end.getTime() < start.getTime()) {
      return res.status(400).json({ ok: false, error: 'end_before_start' });
    }
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days > 366) {
      return res.status(400).json({ ok: false, error: 'range_too_large', hint: 'max 366 days' });
    }
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start.getTime() + i * 86400000);
      const fasting = typeof cal.getFastingRule === 'function' ? cal.getFastingRule(d) : null;
      const saints = typeof cal.saintsForDate === 'function'
        ? cal.saintsForDate(d.getUTCMonth() + 1, d.getUTCDate(), 'new', d.getUTCFullYear())
        : [];
      out.push({
        date: d.toISOString().slice(0, 10),
        fasting,
        saints: saints.map((s) => ({ name: s.name, feast_type: s.feast_type, rank: s.rank })),
      });
    }
    return res.json({ ok: true, start: out[0].date, end: out[out.length - 1].date, count: out.length, days: out });
  });

  // -------------------------------------------------------------------------
  // P0-3 — Unified ask endpoint (§9 modes router)
  //
  // POST /brain/ask
  // Body: { query: string, session_id?: string, force_mode?: string }
  //
  // Routes through orchestrator.ask() which classifies the query via the
  // modes engine and dispatches to calendar / study / prayer / general.
  // -------------------------------------------------------------------------

  app.post('/brain/ask', async (req, res) => {
    if (!orchestrator || typeof orchestrator.ask !== 'function') {
      return res.status(503).json({ ok: false, error: 'ask_not_available',
        hint: 'Orchestrator.ask() is missing. Deploy the P0-3 orchestrator patch.' });
    }

    const b = req.body || {};
    if (!b.query) return res.status(400).json({ ok: false, error: 'query_required' });

    try {
      const result = await orchestrator.ask(b.query, {
        sessionId: b.session_id,
        forceMode: b.force_mode || b.mode,
        btw: b.btw || false,
        useModel: b.use_model || false,
      });
      return res.json({
        ok: true,
        mode: result.mode,
        answer: result.answer,
        recommendation: result.recommendation,
        detail: result.detail || undefined,
        btw_queue: result.btw_queue,
      });
    } catch (e) {
      logger.error('ask_endpoint_error', { name: e && e.name });
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // -------------------------------------------------------------------------
  // 404 catch-all
  // -------------------------------------------------------------------------

  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

  return app;
}

module.exports = { createServer };
