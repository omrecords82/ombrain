'use strict';

/**
 * Reasoning / decision orchestrator (Spec v1.1 §7 reasoning order).
 *
 * PATCH P0-3 (2026-06-27): Added `ask()` method — the unified public entry-point
 * used by:
 *   - CronManager (src/index.js line 69: orchestrator.ask(q))
 *   - POST /brain/ask HTTP endpoint
 *   - QueryPipeline general-mode fallback
 *
 * ask() classifies the query using the modes engine, routes calendar/study/prayer
 * queries to their deterministic handlers, and falls back to diagnose() for
 * governance/operational queries.
 *
 * All other methods are unchanged from the deployed version (commit d681340).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ruleEngine = require('../governance/ruleEngine');
const { redactForModel, redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');
const { config } = require('../config');

// Verification hints per owning system / classification (verification playbook).
const VERIFICATION_HINTS = {
  service_restart:
    'systemctl is-active <unit>; curl -s http://127.0.0.1:7060/omai/health | jq .; ' +
    'GET /api/platform/actions/history?limit=5 (auth).',
  reconcile_stale_deploy:
    'GET /api/deploy-runs?limit=5 — run status reconciled to failed; linked item not stuck running.',
  remove_maintenance_flag:
    'test ! -f /var/www/orthodoxmetrics/maintenance.on; curl -sI https://orthodoxmetrics.com/index.html -> 200.',
  default:
    'Follow 06-brain-verification-playbook.md for the relevant action class; confirm no new critical inventory alerts.',
};

function identifyProtectedConcern(incident) {
  const text = JSON.stringify(incident || {}).toLowerCase();
  if (/church_id|om_church_|tenant/.test(text)) return 'tenant_data';
  if (/secret|password|token|jwt|stripe/.test(text)) return 'secrets';
  if (/auth|session|login|keycloak|oidc/.test(text)) return 'authentication';
  if (/down|502|503|outage|unreachable|crash/.test(text)) return 'system_stability';
  return 'operational_integrity';
}

function identifyOwningSystem(incident) {
  const text = JSON.stringify(incident || {}).toLowerCase();
  if (/omstudio|studio/.test(text)) return 'OMStudio';
  if (/omai|platform|deploy-run|auto-repair|7060/.test(text)) return 'OMAI';
  if (/parish|records|ocr|3001|billing/.test(text)) return 'OM';
  if (/keycloak|auth01|\.254/.test(text)) return 'cross-system';
  return 'OMAI';
}

// ---------------------------------------------------------------------------
// Retrieval-first helpers
// ---------------------------------------------------------------------------

function isProcedureStale(proc) {
  const staleDays = config.learning.procedureStaleAfterDays;
  if (!proc.last_used_at) return true;
  const lastUsed = new Date(proc.last_used_at).getTime();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  return Date.now() - lastUsed > staleMs;
}

function classificationToRisk(classification) {
  if (classification === 'tier0_halt_escalate') return 'destructive';
  if (classification === 'never_auto') return 'destructive';
  if (classification === 'requires_human_superadmin') return 'high';
  if (classification === 'auto_safe_recommendation') return 'medium';
  return 'low';
}

function shouldAutoPromote(riskLevel) {
  if (!config.learning.autoPromoteLowRisk) return false;
  return riskLevel === 'low';
}

class Orchestrator {
  /**
   * @param {object} deps { db, aiClient, governance, modeRouter, btwQueue }
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.ai = deps.aiClient || null;
    this.governance = deps.governance || null;
    this.modeRouter = deps.modeRouter || null;
    this.btwQueue = deps.btwQueue || null;
    this.ragRetriever = deps.ragRetriever || null;
    this.doctrineText = this._loadDoctrine();
  }

  _loadDoctrine() {
    try {
      const { config } = require('../config');
      return fs.readFileSync(path.resolve(process.cwd(), config.memory.doctrinePath), 'utf8');
    } catch (_) {
      return '';
    }
  }

  _detectQuestionType(proposal, protectedConcern) {
    const text = JSON.stringify(proposal || '').toLowerCase();
    if (protectedConcern === 'cross_tenant') return 'cross_tenant_detection';
    if (/restart|reboot|pm2|systemctl|service/.test(text)) return 'service_restart_recommendation';
    if (/schema|migration|alter table|drop table|create table/.test(text)) return 'schema_change_governance';
    if (/never.auto|never auto|forbidden|doctrine/.test(text)) return 'never_auto_action';
    if (/what is|explain|describe|how does|tell me/.test(text)) return 'informational';
    return 'other';
  }

  _recallCorrectionsByType(question_type) {
    if (!this.db) return [];
    try {
      return this.db.correctionsByQuestionType(question_type);
    } catch (_) {
      return [];
    }
  }

  _detectStuckThinking(sessionId, classification) {
    if (!this.db || !sessionId) return { stuck: false, priorAttempts: [] };
    try {
      const prior = this.db.listDecisions
        ? this.db.listDecisions({ session_id: sessionId, limit: 5 })
        : [];
      const matching = prior.filter((d) => d.classification === classification);
      return { stuck: matching.length >= 2, priorAttempts: matching };
    } catch (_) {
      return { stuck: false, priorAttempts: [] };
    }
  }

  _recallSystemTruth(owningSystem) {
    const results = [];

    if (this.db) {
      try {
        const all = this.db.allSystemTruth();
        const sys = String(owningSystem || '').toLowerCase();
        const ranked = all
          .map((f) => ({ f, hit: f.body.toLowerCase().includes(sys) ? 1 : 0 }))
          .sort((a, b) => b.hit - a.hit)
          .slice(0, 8)
          .map((x) => ({
            recall_source: 'system_truth_memory',
            domain: x.f.domain,
            fact_key: x.f.fact_key,
            body: x.f.body,
            source_ref: x.f.source_ref,
          }));
        results.push(...ranked);
      } catch (_) {}
    }

    if (this.db && typeof this.db.searchKnowledge === 'function') {
      try {
        const knowledgeHits = this.db.searchKnowledge(owningSystem || '', { limit: 4 });
        for (const doc of knowledgeHits) {
          results.push({
            recall_source: 'knowledge_memory',
            domain: doc.category || 'knowledge',
            fact_key: doc.slug,
            body: doc.body ? doc.body.slice(0, 600) : '',
            source_ref: doc.source_ref || doc.slug,
            confidence: doc.confidence,
          });
        }
      } catch (_) {}
    }

    return results;
  }

  _tryIngestSkillFromQuery(query, opts = {}) {
    if (!this.db || typeof this.db.upsertSkill !== 'function') return null;

    const {
      normalizeSkillKey,
      isValidSkillKey,
      validateSkillScript,
      VALID_LANGUAGES,
    } = require('../skills/skillSafety');

    let payload = opts.skill || null;
    const q = String(query || '').trim();

    if (!payload && /^learn\s+(?:this\s+)?skill\b/i.test(q)) {
      const metaMatch = q.match(/\bkey=([a-zA-Z0-9_-]+)/i);
      const langMatch = q.match(/\blanguage=(bash|python|node)\b/i);
      const scriptMatch = q.match(/```(?:bash|python|javascript|js|node)?\s*([\s\S]*?)```/);
      if (metaMatch && langMatch && scriptMatch) {
        payload = {
          key: metaMatch[1],
          language: langMatch[1],
          script: scriptMatch[1].trim(),
          description: q.replace(/```[\s\S]*?```/, '').trim(),
        };
      }
    }

    if (!payload || !payload.key || !payload.language || !(payload.script || payload.script_body)) {
      return null;
    }

    const skill_key = normalizeSkillKey(payload.key);
    const language = String(payload.language).toLowerCase();
    const script_body = payload.script || payload.script_body;

    if (!isValidSkillKey(skill_key) || !VALID_LANGUAGES.has(language)) {
      return {
        mode: 'technical',
        answer: 'Skill ingestion failed: invalid key or language (bash|python|node).',
        detail: { skill_ingest: false, error: 'invalid_key_or_language' },
      };
    }

    const validation = validateSkillScript({ script_body, language });
    if (!validation.ok) {
      return {
        mode: 'technical',
        answer: 'Skill ingestion blocked by safety checks: ' + validation.errors.join(', '),
        detail: { skill_ingest: false, errors: validation.errors },
      };
    }

    const existing = this.db.getSkillByKey(skill_key);
    const id = (existing && existing.id) || crypto.randomUUID();
    this.db.upsertSkill({
      id,
      skill_key,
      title: payload.title || skill_key.replace(/-/g, ' '),
      description: payload.description || null,
      language,
      script_body,
      tags_json: payload.tags ? JSON.stringify(payload.tags) : null,
      source: 'learned',
      version: existing ? (existing.version || 1) + 1 : 1,
      active: 1,
    });

    return {
      mode: 'technical',
      answer: `Skill "${skill_key}" memorized (${language}). Run via POST /brain/skills/${skill_key}/run (dry-run default).`,
      detail: {
        skill_ingest: true,
        skill_key,
        language,
        version: existing ? (existing.version || 1) + 1 : 1,
        warnings: validation.warnings.length ? validation.warnings : undefined,
      },
    };
  }

  async _retrieveFromMemory(queryText, owningSystem) {
    if (!this.db || !config.learning.enabled) {
      return { hit: false, source: 'learning_disabled', content: null, procedure: null };
    }

    const q = String(queryText || '').toLowerCase();

    try {
      if (typeof this.db.searchSkills === 'function') {
        const skills = this.db.searchSkills(q, { limit: 3 });
        if (skills.length > 0) {
          const best = skills[0];
          logger.info('retrieval_hit_skill', { skill_key: best.skill_key });
          return {
            hit: true,
            source: 'skill_memory',
            content: skills,
            procedure: null,
            skill: best,
          };
        }
      }
    } catch (e) {
      logger.warn('retrieval_skill_error', { name: e && e.name });
    }

    try {
      const procs = this.db.listProcedures({ approved: true, limit: 20 });
      for (const proc of procs) {
        const matchScore = [
          proc.title, proc.intent_key, proc.procedure_body,
          ...(proc.trigger_examples ? JSON.parse(proc.trigger_examples) : []),
        ].filter(Boolean).some((s) => q.includes(String(s).toLowerCase().slice(0, 30)));

        if (!matchScore) continue;
        if ((proc.confidence || 0) < config.learning.procedureMinConfidence) continue;
        if (isProcedureStale(proc)) {
          logger.info('retrieval_procedure_stale', { slug: proc.slug });
          continue;
        }
        this.db.incrementProcedureUsage(proc.id);
        logger.info('retrieval_hit_procedure', { slug: proc.slug, confidence: proc.confidence });
        return { hit: true, source: 'procedure_memory', content: proc, procedure: proc };
      }
    } catch (e) {
      logger.warn('retrieval_procedure_error', { name: e && e.name });
    }

    try {
      if (this.ragRetriever && typeof this.db.listKnowledge === 'function') {
        const rows = this.db.listKnowledge({ limit: 200 });
        const ranked = await this.ragRetriever.retrieve(q, rows, { k: 5, textField: 'body' });
        if (ranked.length > 0) {
          const hits = ranked.map((r) => ({ ...r.meta, body: r.text, _rag_score: r.score }));
          logger.info('retrieval_hit_knowledge_rag', { count: hits.length });
          return { hit: true, source: 'knowledge_memory', content: hits, procedure: null };
        }
      }
      const hits = this.db.searchKnowledge(q, { limit: 5 });
      if (hits && hits.length > 0) {
        logger.info('retrieval_hit_knowledge', { count: hits.length });
        return { hit: true, source: 'knowledge_memory', content: hits, procedure: null };
      }
    } catch (e) {
      logger.warn('retrieval_knowledge_error', { name: e && e.name });
    }

    let corrections = [];
    try {
      corrections = this.db.listCorrections({ limit: 10 });
    } catch (_) {}

    let tasks = [];
    try {
      tasks = this.db.listTasks({ status: 'open', limit: 10 });
    } catch (_) {}

    return { hit: false, source: 'llm_required', content: null, procedure: null, corrections, tasks };
  }

  _extractAndLearn(opts = {}) {
    if (!this.db || !config.learning.enabled) return null;
    const { decisionId, sessionId, advisory, classification, owningSystem } = opts;
    if (!advisory || typeof advisory !== 'string' || advisory.length < 40) return null;

    const riskLevel = classificationToRisk(classification);
    if (riskLevel === 'destructive') {
      logger.info('learning_skip_destructive', { classification });
      return null;
    }

    const slug = 'auto-' + sessionId.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    const autoApprove = shouldAutoPromote(riskLevel);
    const confidence = autoApprove ? 0.85 : 0.0;

    try {
      const id = crypto.randomUUID();
      this.db.upsertProcedure({
        id, slug,
        title: 'Auto-learned: ' + (owningSystem || 'unknown') + ' / ' + classification,
        intent_key: classification,
        mode: riskLevel === 'low' ? 'knowledge' : 'technical',
        trigger_examples: null,
        procedure_body: advisory,
        commands_json: null,
        required_permissions: null,
        risk_level: riskLevel,
        validation_steps: null,
        source_decision_id: decisionId || null,
        source_type: 'llm_advisory',
        confidence,
        approved: autoApprove ? 1 : 0,
        approved_by: autoApprove ? 'auto_promote' : null,
        usage_count: 0,
      });
      logger.info('learning_procedure_drafted', { slug, risk_level: riskLevel, auto_approved: autoApprove });
      return { id, slug, risk_level: riskLevel, auto_approved: autoApprove, approval_required: !autoApprove };
    } catch (e) {
      logger.warn('learning_extract_error', { name: e && e.name });
      return null;
    }
  }

  _isTheologicalQuestion(text) {
    const t = String(text || '').toLowerCase();
    return /\b(god|christ|jesus|holy spirit|trinity|theosis|salvation|church|orthodox|saint|scripture|bible|gospel|epistle|liturgy|sacrament|mystery|baptism|eucharist|chrismation|confession|unction|marriage|ordination|pascha|easter|fasting|prayer|icon|theotokos|virgin mary|apostle|prophet|martyr|father|council|canon|dogma|theology|doctrine|sin|repentance|resurrection|incarnation|logos|hypostasis|ousia|physis|chalcedon|nicaea|ephesus|constantinople|ecumenical|catechism|creed|nicene|apostles)\b/.test(t);
  }

  async _recallTheology(question) {
    if (!this.db) return [];
    const { config } = require('../config');
    if (!config.theology || !config.theology.enabled) return [];
    const topK = config.theology.topK || 8;
    try {
      if (this.ragRetriever && typeof this.db.listTheology === 'function') {
        const rows = this.db.listTheology({ limit: 500 });
        const ranked = await this.ragRetriever.retrieve(question, rows, { k: topK, textField: 'body' });
        if (ranked.length > 0) {
          return ranked.map((r) => ({ ...r.meta, body: r.text, _rag_score: r.score }));
        }
      }
      return this.db.searchTheology(question, { limit: topK });
    } catch (e) {
      logger.warn('recall_theology_error', { name: e && e.name });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // P0-3: ask() — unified public entry-point for the modes/query pipeline.
  //
  // Routes the query through the modes engine first (calendar, study, prayer),
  // then falls back to diagnose() for governance/operational queries.
  //
  // Returns a plain string answer suitable for the cron query-poll reporter
  // and the /brain/ask HTTP endpoint.
  // ---------------------------------------------------------------------------

  /**
   * Classify and answer a free-form user query.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string} [opts.sessionId]
   * @param {string} [opts.forceMode]  - Override intent classification
   * @returns {Promise<{ mode: string, answer: string, detail: object }>}
   */
  async ask(query, opts = {}) {
    const sessionId = opts.sessionId || 'ask-' + Date.now().toString(36);
    const q = String(query || '').trim();

    if (!q) {
      return { mode: 'general', answer: 'Please provide a question.', detail: {} };
    }

    const skillIngest = this._tryIngestSkillFromQuery(q, opts);
    if (skillIngest) {
      return { session_id: sessionId, ...skillIngest };
    }

    const { matchOperationIntent, runOperation } = require('../operations');
    const opHint = matchOperationIntent(q);
    if (opHint) {
      const execute = !!(opts.execute || opts.commit);
      if (!execute) {
        return {
          mode: 'ops',
          session_id: sessionId,
          answer:
            `This looks like a request to run the **${opHint.title}** operation (\`${opHint.operation_id}\`). ` +
            'Pass `execute: true` on `/brain/ask` (and `commit: true` to persist) or use ' +
            '`POST /brain/operations/doc-registry-scan/run`.',
          detail: { operation_suggestion: opHint },
        };
      }
      if (this.db && typeof this.db.createOperationRun === 'function') {
        const out = runOperation(this.db, opHint.operation_id, {
          commit: !!opts.commit,
          dry_run: !opts.commit,
          description: q.slice(0, 500),
          triggered_by: 'ask',
        });
        return {
          mode: 'ops',
          session_id: sessionId,
          answer: out.ok
            ? `Operation \`${opHint.operation_id}\` completed (run ${out.run_id}). ${out.output_summary || ''}`
            : `Operation \`${opHint.operation_id}\` failed: ${out.output_summary || out.error}`,
          detail: { operation_run: out },
        };
      }
    }

    if (opts.btw && this.btwQueue) {
      const mode = opts.mode || (this.modeRouter && typeof this.modeRouter.classifyIntent === 'function'
        ? this.modeRouter.classifyIntent(q)
        : 'auto');
      const result = this.btwQueue.enqueue({ session_id: sessionId, question: q, mode });
      return { ...result, session_id: sessionId, mode };
    }

    if (this.modeRouter && typeof this.modeRouter.routeQuery === 'function') {
      let mode = opts.mode || opts.forceMode;
      if (!mode && typeof this.modeRouter.classifyIntent === 'function') {
        mode = this.modeRouter.classifyIntent(q);
      }
      if (!mode) mode = 'ops';

      if (mode === 'knowledge' || mode === 'technical' || mode === 'ops') {
        logger.info('ask_routing', { session_id: sessionId, mode, query: q.slice(0, 80) });
        let primaryResult;
        try {
          if ((mode === 'knowledge' || mode === 'technical')) {
            primaryResult = await this.modeRouter.routeQuery(q, {
              db: this.db,
              ai: this.ai,
              sessionId,
              useModel: opts.useModel,
            });
            primaryResult = { mode, session_id: sessionId, ...primaryResult };
          } else {
            const result = await this.diagnose({
              sessionId,
              incident: q,
              proposal: q,
              useModel: opts.useModel,
            });
            primaryResult = { mode: 'ops', ...result };
          }
        } catch (err) {
          primaryResult = {
            mode,
            session_id: sessionId,
            ok: false,
            error: 'ask_route_error',
            detail: err && err.message,
          };
        }

        let btwAnswered = [];
        if (this.btwQueue && typeof this.btwQueue.process === 'function') {
          try {
            btwAnswered = await this.btwQueue.process(sessionId, { db: this.db, ai: this.ai });
          } catch (_) {}
        }

        return {
          ...primaryResult,
          btw_queue: btwAnswered.length > 0 ? btwAnswered : undefined,
        };
      }
    }

    // Lazy-load the modes engine and pipeline handlers to avoid circular deps
    // at module load time.  These modules are already on disk in src/.
    let classifyIntent, handleCalendar, handleStudy, handlePrayer;
    try {
      ({ classifyIntent } = require('../modes/index'));
      ({ handleCalendar, handleStudy, handlePrayer } = require('../queryPipeline/pipeline'));
      // pastoral/ops handlers are required lazily at their branch sites
    } catch (e) {
      logger.warn('ask_mode_import_error', { name: e && e.name });
      // Fall through to diagnose() if modes modules are unavailable
      const result = await this.diagnose({ sessionId, incident: q, proposal: q, useModel: false });
      return { mode: 'general', answer: result.recommendation || 'No answer available.', detail: result };
    }

    const mode = opts.forceMode || classifyIntent(q);
    logger.info('ask_classified', { session_id: sessionId, mode, query: q.slice(0, 80) });

    try {
      let detail;

      if (mode === 'calendar') {
        detail = await handleCalendar(q);
        return { mode, answer: detail.answer, detail };
      }

      if (mode === 'study') {
        // Prefer theology RAG if enabled and question is theological
        if (this._isTheologicalQuestion(q)) {
          const chunks = await this._recallTheology(q);
          if (chunks.length > 0) {
            const citations = chunks.map((c) => ({
              source_ref: c.source_ref || c.reference_key,
              source: c.source,
              category: c.category,
              body: c.body ? c.body.slice(0, 400) : '',
            }));
            // Attempt LLM answer if available
            let answer = null;
            if (this.ai) {
              try {
                const context = chunks.map((c) => `[${c.source_ref || c.reference_key}] ${c.body}`).join('\n\n');
                const prompt =
                  'You are an Orthodox Christian theological assistant. Answer the following question ' +
                  'using ONLY the provided sources. Always cite your sources. If the Fathers are not ' +
                  'unanimous on a topic, note that explicitly.\n\nQuestion: ' + q +
                  '\n\nSources:\n' + context;
                const adv = await this.ai.complete({ prompt, sessionId });
                if (adv && adv.ok) answer = adv.content;
              } catch (_) {}
            }
            return {
              mode: 'study',
              answer: answer || '(AI client unavailable — see citations)',
              detail: { type: 'study.theology_rag', citations, source_count: citations.length },
            };
          }
        }
        detail = await handleStudy(q);
        return { mode, answer: detail.answer, detail };
      }

      if (mode === 'prayer') {
        detail = await handlePrayer(q);
        return { mode, answer: detail.answer, detail };
      }

      if (mode === 'pastoral') {
        const { handlePastoral } = require('../queryPipeline/pipeline');
        detail = await handlePastoral(q);
        return { mode, answer: detail.answer, detail };
      }

      if (mode === 'church') {
        const { handleChurch } = require('../queryPipeline/pipeline');
        const detail = await handleChurch(q, {
          omaiProxyUrl: process.env.OMAI_PROXY_URL || 'http://192.168.1.239:7060',
        });
        return { mode, answer: detail.answer, detail };
      }

      // general / fallback: route to diagnose()
      const result = await this.diagnose({ sessionId, incident: q, proposal: q, useModel: !!(this.ai) });
      const response = { mode: 'general', answer: result.recommendation || 'No answer available.', detail: result };

      if (this.btwQueue && typeof this.btwQueue.process === 'function') {
        try {
          const btwAnswered = await this.btwQueue.process(sessionId, { db: this.db, ai: this.ai });
          if (btwAnswered.length > 0) response.btw_queue = btwAnswered;
        } catch (_) {}
      }

      return response;

    } catch (err) {
      logger.warn('ask_handler_error', { mode, name: err && err.name });
      return { mode, answer: `An error occurred processing your ${mode} query. Please try again.`, detail: { error: err.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // diagnose() — unchanged from commit d681340
  // ---------------------------------------------------------------------------

  /**
   * Run a full diagnose cycle.
   * @param {object} input { sessionId, incident, proposal, context, useModel }
   * @returns {Promise<object>} decision record (also persisted)
   */
  async diagnose(input = {}) {
    const sessionId = input.sessionId || 'sess-' + Date.now().toString(36);
    const incident = redactForLog(input.incident || {});
    const proposal = input.proposal || incident.proposal || incident;
    const context = Object.assign({}, input.context || {}, {
      sessionChurchId: input.context && input.context.sessionChurchId,
      accessedChurchId: input.context && input.context.accessedChurchId,
      crossTenant: input.context && input.context.crossTenant,
    });

    // §6 — Theological query short-circuit
    const questionText = typeof (input.proposal || input.incident) === 'string'
      ? (input.proposal || input.incident)
      : JSON.stringify(input.proposal || input.incident || '');
    if (this._isTheologicalQuestion(questionText)) {
      const { config } = require('../config');
      if (config.theology && config.theology.enabled) {
        const chunks = await this._recallTheology(questionText);
        const citations = chunks.map((c) => ({
          source_ref: c.source_ref || c.reference_key,
          source: c.source,
          category: c.category,
          body: c.body ? c.body.slice(0, 500) : '',
        }));
        const hasPatristic = citations.some((c) => c.category === 'patristic');
        const unanimityNote = hasPatristic
          ? 'Note: Patristic sources are included. Where the Fathers are not unanimous, this is noted in the citations.'
          : null;
        return {
          session_id: sessionId,
          theological_query: true,
          question: questionText,
          citations,
          source_count: citations.length,
          unanimity_note: unanimityNote,
          governance_applied: false,
          executed: false,
        };
      }
    }

    const protectedConcern = identifyProtectedConcern(incident);
    const owningSystem = identifyOwningSystem(incident);
    const systemTruth = this._recallSystemTruth(owningSystem);

    const questionType = this._detectQuestionType(proposal || incident, protectedConcern);
    const typeCorrections = this._recallCorrectionsByType(questionType);

    const queryText = JSON.stringify(redactForLog(proposal || incident));
    const retrieval = await this._retrieveFromMemory(queryText, owningSystem);

    let memoryHit = retrieval.hit;
    let memorySource = retrieval.source;
    let memoryContent = retrieval.content;
    let knownCorrections = retrieval.corrections || [];
    let openTasks = retrieval.tasks || [];

    let modelAdvisory = null;
    let escalation = null;
    const llmSkipped = memoryHit && config.learning.llmMinimizationEnabled;

    if (!llmSkipped && input.useModel && this.ai) {
      const adv = await this.ai.governanceAdvisory({
        proposal: redactForModel(proposal),
        doctrine: this.doctrineText,
        sessionId,
      });
      if (adv.ok) modelAdvisory = adv.content;
      else escalation = adv.escalation;
    }

    let stumbleEscalated = false;
    let stumbleReason = null;
    if (typeCorrections.length >= config.learning.stumbleThreshold) {
      stumbleEscalated = true;
      stumbleReason = `stumble_threshold_exceeded (${typeCorrections.length} corrections for question_type=${questionType})`;
      logger.warn('stumble_threshold_exceeded', { question_type: questionType, count: typeCorrections.length });
    }

    const stuckCheck = this._detectStuckThinking(sessionId, memorySource);
    const modelAdvisoryPrefix = [
      typeCorrections.length > 0
        ? `KNOWN CORRECTIONS FOR ${questionType}:\n` +
          typeCorrections.map((c) => `- ${c.correction || c.correct_answer}`).join('\n')
        : null,
      stuckCheck.stuck
        ? `PRIOR ATTEMPTS (same session, same classification):\n` +
          stuckCheck.priorAttempts.map((d) => `- ${d.recommendation}`).join('\n')
        : null,
    ].filter(Boolean).join('\n\n');

    const verdict = ruleEngine.evaluate(proposal, context, modelAdvisory);

    if (stumbleEscalated && verdict.classification !== 'tier0_halt_escalate') {
      verdict.classification = 'requires_human_superadmin';
      verdict.domains = [...(verdict.domains || []), 'stumble_escalation'];
      verdict.requiresOmstudio = true;
    }

    const owningFromVerdict = owningSystem;
    let recommendation;
    let verificationSteps;
    const actionId =
      (proposal && typeof proposal === 'object' && (proposal.action || proposal.id)) ||
      (typeof proposal === 'string' ? proposal : 'observe');

    switch (verdict.classification) {
      case 'tier0_halt_escalate':
        recommendation =
          'HALT. Do not auto-remediate. Preserve logs (platform_events, activity_log, nginx access). ' +
          'Escalate to a human super_admin with the standard T0 data package.';
        verificationSteps = 'Human-led tenant isolation review per 08-brain-tenant-isolation.md. No Brain action.';
        break;
      case 'never_auto':
        recommendation =
          'Explain the requested operation and escalate. This is a NEVER-AUTO action; the Brain will not ' +
          'execute it and does not recommend autonomous execution. Requires human super_admin via OMStudio.';
        verificationSteps = VERIFICATION_HINTS.default;
        break;
      case 'requires_human_superadmin':
        recommendation =
          'Proposal touches a human-only domain (' + verdict.domains.join(', ') + '). ' +
          'Mark "requires human superadmin approval via OMStudio". Observe/analyze/explain only.';
        verificationSteps = VERIFICATION_HINTS.default;
        break;
      case 'auto_safe_recommendation':
        recommendation =
          'RECOMMEND (do not execute) documented safe action: ' + String(actionId) + '. ' +
          'Present to a human operator; the Brain does not perform it.';
        verificationSteps = VERIFICATION_HINTS[actionId] || VERIFICATION_HINTS.default;
        break;
      default:
        recommendation =
          'Observation only. No governed action implied. Continue to monitor and explain.';
        verificationSteps = VERIFICATION_HINTS.default;
    }

    const rationale =
      `protected_concern=${protectedConcern}; owning_system=${owningFromVerdict}; ` +
      `deterministic_classification=${verdict.classification}; ` +
      `domains=[${verdict.domains.join(',')}]; ` +
      `tenant_cross=${verdict.tenant.crossTenant}; ` +
      'LLM advisory is non-authoritative and cannot override this verdict.';

    const decision = {
      session_id: sessionId,
      classification: verdict.classification,
      recommendation,
      rationale,
      doctrine_rule: verdict.doctrineRule,
      owning_system: owningFromVerdict,
      verification_steps: verificationSteps,
      model_advisory: modelAdvisory,
      requires_omstudio: verdict.requiresOmstudio,
    };

    if (this.db) {
      try {
        this.db.upsertWorkSession({
          session_id: sessionId,
          work_item_ref: input.workItemRef || null,
          incident_tier: verdict.tenant.crossTenant ? 'T0' : null,
          state: verdict.requiresOmstudio ? 'escalated' : 'recommended',
          context_json: JSON.stringify(redactForLog(context)),
        });
        const id = this.db.appendDecision(decision);
        decision.id = id;
      } catch (e) {
        logger.error('orchestrator_persist_error', { name: e && e.name });
      }
    }

    let governanceResult = null;
    if (this.governance) {
      try {
        governanceResult = await this.governance.processDecision(decision, verdict);
      } catch (e) {
        logger.warn('governance_process_error', { name: e && e.name });
      }
    }

    let learnedProcedure = null;
    if (!llmSkipped && modelAdvisory && config.learning.enabled) {
      learnedProcedure = this._extractAndLearn({
        decisionId: decision.id || null,
        sessionId,
        advisory: modelAdvisory,
        classification: verdict.classification,
        owningSystem,
      });
    }

    logger.info('diagnose_complete', {
      session_id: sessionId,
      classification: verdict.classification,
      requires_omstudio: verdict.requiresOmstudio,
      memory_hit: memoryHit,
      memory_source: memorySource,
      llm_skipped: llmSkipped,
      procedure_learned: !!learnedProcedure,
    });

    return {
      session_id: sessionId,
      protected_concern: protectedConcern,
      owning_system: owningFromVerdict,
      system_truth_recalled: systemTruth,
      memory: {
        hit: memoryHit,
        source: memorySource,
        content: memoryContent,
        known_corrections: knownCorrections.length > 0 ? knownCorrections : undefined,
        open_tasks: openTasks.length > 0 ? openTasks : undefined,
      },
      correction_context: {
        question_type: questionType,
        known_corrections: typeCorrections.length > 0 ? typeCorrections : undefined,
        stuck_thinking: stuckCheck.stuck,
        prior_attempts: stuckCheck.stuck ? stuckCheck.priorAttempts : undefined,
        stumble_escalated: stumbleEscalated,
        auto_escalated_reason: stumbleReason || undefined,
        model_advisory_confidence: stuckCheck.stuck ? 'low' : undefined,
      },
      execution_source: {
        local_deterministic_engine: true,
        local_memory_used: memoryHit,
        local_memory_source: memoryHit ? memorySource : null,
        llm_used: !llmSkipped && !!modelAdvisory,
        llm_skipped_reason: llmSkipped ? 'high_confidence_local_procedure' : null,
        procedure_learned: !!learnedProcedure,
        procedure_approval_required: learnedProcedure ? learnedProcedure.approval_required : null,
        procedure_slug: learnedProcedure ? learnedProcedure.slug : null,
      },
      governance: {
        classification: verdict.classification,
        domains: verdict.domains,
        requires_omstudio: verdict.requiresOmstudio,
        doctrine_rule: verdict.doctrineRule,
        tenant: verdict.tenant,
        auto_safe: verdict.autoSafe,
        never_auto: verdict.neverAuto,
        model_advisory_authoritative: false,
      },
      recommendation,
      verification_steps: verificationSteps,
      model_advisory: modelAdvisory,
      escalation,
      decision_ledger_id: decision.id || null,
      omstudio: governanceResult
        ? {
            audited: governanceResult.audited,
            audit_ref: governanceResult.audit_ref,
            requires_human_superadmin_approval: governanceResult.requires_human_superadmin_approval,
            omstudio_approval_ref: governanceResult.omstudio_approval_ref,
            approval_id: governanceResult.approval_id,
            status: governanceResult.approval_state,
          }
        : null,
      requires_human_superadmin_approval: governanceResult
        ? governanceResult.requires_human_superadmin_approval
        : verdict.requiresOmstudio,
      executed: false,
    };
  }
}

module.exports = { Orchestrator };
