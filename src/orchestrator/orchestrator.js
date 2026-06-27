'use strict';

/**
 * Reasoning / decision orchestrator (Spec v1.1 §7 reasoning order).
 *
 * Implements the strict reasoning order:
 *   1. identify the protected concern
 *   2. identify the owning system
 *   3. recall system-truth
 *   4. evaluate authority via the DETERMINISTIC engine (authoritative)
 *   5. if outside authority → mark requires-human-superadmin (via OMStudio)
 *   6. if inside → propose a documented safe action + how to verify
 *
 * The LLM (diagnostic + governance-advisory) provides analysis/explanation and a
 * NON-authoritative advisory note. Every run writes a Decision Memory ledger
 * entry. The Brain NEVER executes anything.
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

/**
 * Score a procedure for staleness. Returns true if the procedure is stale
 * (not used within BRAIN_PROCEDURE_STALE_AFTER_DAYS).
 */
function isProcedureStale(proc) {
  const staleDays = config.learning.procedureStaleAfterDays;
  if (!proc.last_used_at) return true;
  const lastUsed = new Date(proc.last_used_at).getTime();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  return Date.now() - lastUsed > staleMs;
}

/**
 * Determine the risk level for a given governance classification so that
 * auto-learned procedures are assigned the correct risk tier.
 */
function classificationToRisk(classification) {
  if (classification === 'tier0_halt_escalate') return 'destructive';
  if (classification === 'never_auto') return 'destructive';
  if (classification === 'requires_human_superadmin') return 'high';
  if (classification === 'auto_safe_recommendation') return 'medium';
  return 'low';
}

/**
 * Decide whether a draft procedure should be auto-promoted based on its
 * risk level and the current learning config.
 */
function shouldAutoPromote(riskLevel) {
  if (!config.learning.autoPromoteLowRisk) return false;
  return riskLevel === 'low';
}

class Orchestrator {
  /**
   * @param {object} deps { db, aiClient }
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.ai = deps.aiClient || null;
    // Optional governance manager (OMStudio audit + approval surfacing). When
    // absent the orchestrator still works; governance fields are simply omitted.
    this.governance = deps.governance || null;
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

  /**
   * Detect the question_type for a given proposal/incident.
   * Maps the incoming request to one of the spec §5a question_type buckets.
   * This runs BEFORE the deterministic rule engine and is used for:
   *   a) fetching relevant corrections from correction_memory
   *   b) stumble-threshold escalation check
   */
  _detectQuestionType(proposal, protectedConcern) {
    const text = JSON.stringify(proposal || '').toLowerCase();
    if (protectedConcern === 'cross_tenant') return 'cross_tenant_detection';
    if (/restart|reboot|pm2|systemctl|service/.test(text)) return 'service_restart_recommendation';
    if (/schema|migration|alter table|drop table|create table/.test(text)) return 'schema_change_governance';
    if (/never.auto|never auto|forbidden|doctrine/.test(text)) return 'never_auto_action';
    if (/what is|explain|describe|how does|tell me/.test(text)) return 'informational';
    return 'other';
  }

  /**
   * Recall active corrections for a specific question_type.
   * Returns an array of correction rows to inject as KNOWN CORRECTIONS.
   */
  _recallCorrectionsByType(question_type) {
    if (!this.db) return [];
    try {
      return this.db.correctionsByQuestionType(question_type);
    } catch (_) {
      return [];
    }
  }

  /**
   * Detect stuck-thinking: same session_id or work_item_ref produced the same
   * classification + recommendation in a prior attempt.
   * Returns { stuck: bool, priorAttempts: [] }
   */
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
    if (!this.db) return [];
    try {
      const all = this.db.allSystemTruth();
      // Lightweight recall: prefer facts whose body mentions the owning system.
      const sys = String(owningSystem || '').toLowerCase();
      const ranked = all
        .map((f) => ({ f, hit: f.body.toLowerCase().includes(sys) ? 1 : 0 }))
        .sort((a, b) => b.hit - a.hit)
        .slice(0, 8)
        .map((x) => ({ domain: x.f.domain, fact_key: x.f.fact_key, body: x.f.body, source_ref: x.f.source_ref }));
      return ranked;
    } catch (_) {
      return [];
    }
  }

  /**
   * Retrieval-first pipeline (Phase 2).
   *
   * Searches local memory in the canonical order before calling the LLM:
   *   1. procedure_memory  (approved, high-confidence, non-stale)
   *   2. knowledge_memory  (durable facts)
   *   3. system_truth_memory (platform architecture facts)
   *   4. correction_memory (known mistakes to avoid)
   *   5. task_memory       (active obligations)
   *
   * Returns { hit: bool, source: string, content: object|null, procedure: object|null }
   */
  _retrieveFromMemory(queryText, owningSystem) {
    if (!this.db || !config.learning.enabled) {
      return { hit: false, source: 'learning_disabled', content: null, procedure: null };
    }

    const q = String(queryText || '').toLowerCase();

    // 1. procedure_memory — approved, confidence >= threshold, non-stale
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
        // Hit — increment usage and return
        this.db.incrementProcedureUsage(proc.id);
        logger.info('retrieval_hit_procedure', { slug: proc.slug, confidence: proc.confidence });
        return { hit: true, source: 'procedure_memory', content: proc, procedure: proc };
      }
    } catch (e) {
      logger.warn('retrieval_procedure_error', { name: e && e.name });
    }

    // 2. knowledge_memory — full-text search
    try {
      const hits = this.db.searchKnowledge(q, { limit: 5 });
      if (hits && hits.length > 0) {
        logger.info('retrieval_hit_knowledge', { count: hits.length });
        return { hit: true, source: 'knowledge_memory', content: hits, procedure: null };
      }
    } catch (e) {
      logger.warn('retrieval_knowledge_error', { name: e && e.name });
    }

    // 2b. theological_memory — scripture, catechism, councils, patristic (Tier 4)
    if (config.theology.enabled) {
      try {
        const theo = this.db.searchTheology(q, { limit: config.theology.topK });
        if (theo && theo.length > 0) {
          logger.info('retrieval_hit_theology', { count: theo.length });
          return { hit: true, source: 'theological_memory', content: theo, procedure: null };
        }
      } catch (e) {
        logger.warn('retrieval_theology_error', { name: e && e.name });
      }
    }

    // 3. system_truth_memory — already recalled in diagnose(); pass through
    // (system truth is always recalled and included in the response regardless)

    // 4. correction_memory — surface known mistakes as context (not a full hit)
    let corrections = [];
    try {
      corrections = this.db.listCorrections({ limit: 10 });
    } catch (_) {}

    // 5. task_memory — surface open obligations as context
    let tasks = [];
    try {
      tasks = this.db.listTasks({ status: 'open', limit: 10 });
    } catch (_) {}

    return { hit: false, source: 'llm_required', content: null, procedure: null, corrections, tasks };
  }

  /**
   * Post-LLM learning: extract a reusable procedure draft from the LLM
   * advisory and store it in procedure_memory (pending approval unless
   * auto-promote applies).
   *
   * @param {object} opts { decisionId, sessionId, advisory, classification, owningSystem }
   * @returns {object|null} the created procedure record or null
   */
  _extractAndLearn(opts = {}) {
    if (!this.db || !config.learning.enabled) return null;
    const { decisionId, sessionId, advisory, classification, owningSystem } = opts;
    if (!advisory || typeof advisory !== 'string' || advisory.length < 40) return null;

    const riskLevel = classificationToRisk(classification);
    // Never auto-learn destructive procedures
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
        id,
        slug,
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
      logger.info('learning_procedure_drafted', {
        slug, risk_level: riskLevel, auto_approved: autoApprove,
      });
      return { id, slug, risk_level: riskLevel, auto_approved: autoApprove, approval_required: !autoApprove };
    } catch (e) {
      logger.warn('learning_extract_error', { name: e && e.name });
      return null;
    }
  }

  /**
   * §6 — Classify whether a question is theological in nature.
   * Returns true when the question should be routed to the theology RAG path
   * instead of the governance/diagnostic path.
   */
  _isTheologicalQuestion(text) {
    const t = String(text || '').toLowerCase();
    return /\b(god|christ|jesus|holy spirit|trinity|theosis|salvation|church|orthodox|saint|scripture|bible|gospel|epistle|liturgy|sacrament|mystery|baptism|eucharist|chrismation|confession|unction|marriage|ordination|pascha|easter|fasting|prayer|icon|theotokos|virgin mary|apostle|prophet|martyr|father|council|canon|dogma|theology|doctrine|sin|repentance|resurrection|incarnation|logos|hypostasis|ousia|physis|chalcedon|nicaea|ephesus|constantinople|ecumenical|catechism|creed|nicene|apostles)\b/.test(t);
  }

  /**
   * §6 — Retrieve top-N relevant theological_memory chunks for a question.
   * Uses semantic search when embeddings are available; falls back to keyword.
   */
  _recallTheology(question) {
    if (!this.db) return [];
    const { config } = require('../config');
    if (!config.theology || !config.theology.enabled) return [];
    const topK = config.theology.topK || 8;
    try {
      // Keyword fallback (embedding path requires embed-theology.js to have run)
      return this.db.searchTheology(question, { limit: topK });
    } catch (_) {
      return [];
    }
  }

  /**
   * Run a full diagnose cycle.
   * @param {object} input { sessionId, incident, proposal, context, useModel }
   * @returns {Promise<object>} decision record (also persisted)
   */
  async diagnose(input = {}) {
    const sessionId = input.sessionId || 'sess-' + Date.now().toString(36);
    // Everything that may be persisted/sent to a model is redacted first.
    const incident = redactForLog(input.incident || {});
    const proposal = input.proposal || incident.proposal || incident;
    const context = Object.assign({}, input.context || {}, {
      sessionChurchId: input.context && input.context.sessionChurchId,
      accessedChurchId: input.context && input.context.accessedChurchId,
      crossTenant: input.context && input.context.crossTenant,
    });

    // §6 — Theological query short-circuit
    // If the question is theological and the theology layer is enabled,
    // bypass the governance rule engine entirely and return a RAG response.
    // Governance rules do NOT apply to theological questions.
    const questionText = typeof (input.proposal || input.incident) === 'string'
      ? (input.proposal || input.incident)
      : JSON.stringify(input.proposal || input.incident || '');
    if (this._isTheologicalQuestion(questionText)) {
      const { config } = require('../config');
      if (config.theology && config.theology.enabled) {
        const chunks = this._recallTheology(questionText);
        const citations = chunks.map((c) => ({
          source_ref: c.source_ref || c.reference_key,
          source: c.source,
          category: c.category,
          body: c.body ? c.body.slice(0, 500) : '',
        }));
        // Note when Fathers are not unanimous
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

    // 1) protected concern
    const protectedConcern = identifyProtectedConcern(incident);
    // 2) owning system
    const owningSystem = identifyOwningSystem(incident);
    // 3) recall system truth
    const systemTruth = this._recallSystemTruth(owningSystem);

    // §5 — 3a) detect question_type for correction recall + stumble-threshold
    const questionType = this._detectQuestionType(proposal || incident, protectedConcern);

    // §5 — 3b) recall active corrections for this question_type
    const typeCorrections = this._recallCorrectionsByType(questionType);

    // -----------------------------------------------------------------------
    // Phase 2: Retrieval-first pipeline
    // Search local memory before calling the LLM. If a high-confidence
    // approved procedure exists, skip the LLM entirely.
    // -----------------------------------------------------------------------
    const queryText = JSON.stringify(redactForLog(proposal || incident));
    const retrieval = this._retrieveFromMemory(queryText, owningSystem);

    let memoryHit = retrieval.hit;
    let memorySource = retrieval.source;
    let memoryContent = retrieval.content;
    let knownCorrections = retrieval.corrections || [];
    let openTasks = retrieval.tasks || [];

    // (optional) model advisory — NON-authoritative. Only attached, never decisive.
    // Skipped if retrieval-first found a high-confidence local procedure.
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
      else escalation = adv.escalation; // circuit breaker / inference failure
    }

    // §5 — 4a) stumble-threshold check
    // If this question_type has accumulated >= BRAIN_STUMBLE_THRESHOLD active
    // corrections, override the classification to requires_human_superadmin
    // BEFORE the rule engine runs. The deterministic engine remains authoritative
    // for all other paths; this is an additional safety escalation only.
    let stumbleEscalated = false;
    let stumbleReason = null;
    if (typeCorrections.length >= config.learning.stumbleThreshold) {
      stumbleEscalated = true;
      stumbleReason = `stumble_threshold_exceeded (${typeCorrections.length} corrections for question_type=${questionType})`;
      logger.warn('stumble_threshold_exceeded', { question_type: questionType, count: typeCorrections.length });
    }

    // §5 — 4b) stuck-thinking detection
    // Pre-evaluate the likely classification to check if we are stuck.
    // We use the retrieval result as a proxy; a full pre-evaluation is not done
    // here to avoid double-running the rule engine.
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

    // 4) evaluate authority via DETERMINISTIC engine (authoritative)
    const verdict = ruleEngine.evaluate(proposal, context, modelAdvisory);

    // Apply stumble escalation on top of the deterministic verdict (additive only)
    if (stumbleEscalated && verdict.classification !== 'tier0_halt_escalate') {
      verdict.classification = 'requires_human_superadmin';
      verdict.domains = [...(verdict.domains || []), 'stumble_escalation'];
      verdict.requiresOmstudio = true;
    }

    // 5/6) formulate recommendation
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

    // persist work + decision (append-only)
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

    // OMStudio governance surface: audit every decision; for human-only /
    // Tier 0 classifications create+submit an approval request. The Brain still
    // NEVER executes; it only tracks the approval lifecycle.
    let governanceResult = null;
    if (this.governance) {
      try {
        governanceResult = await this.governance.processDecision(decision, verdict);
      } catch (e) {
        logger.warn('governance_process_error', { name: e && e.name });
      }
    }

    // -----------------------------------------------------------------------
    // Phase 2: Post-LLM learning
    // If the LLM was called and produced an advisory, attempt to extract a
    // reusable procedure draft and store it in procedure_memory.
    // -----------------------------------------------------------------------
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
      // Phase 2: memory context
      memory: {
        hit: memoryHit,
        source: memorySource,
        content: memoryContent,
        known_corrections: knownCorrections.length > 0 ? knownCorrections : undefined,
        open_tasks: openTasks.length > 0 ? openTasks : undefined,
      },
      // §5: correction memory context
      correction_context: {
        question_type: questionType,
        known_corrections: typeCorrections.length > 0 ? typeCorrections : undefined,
        stuck_thinking: stuckCheck.stuck,
        prior_attempts: stuckCheck.stuck ? stuckCheck.priorAttempts : undefined,
        stumble_escalated: stumbleEscalated,
        auto_escalated_reason: stumbleReason || undefined,
        model_advisory_confidence: stuckCheck.stuck ? 'low' : undefined,
      },
      // Phase 2: execution source footer (visible on every response)
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
      // Top-level convenience flag mirroring the governance result.
      requires_human_superadmin_approval: governanceResult
        ? governanceResult.requires_human_superadmin_approval
        : verdict.requiresOmstudio,
      executed: false, // the Brain NEVER executes
    };
  }
}

module.exports = { Orchestrator };
