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
const ruleEngine = require('../governance/ruleEngine');
const { redactForModel, redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

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

    // 1) protected concern
    const protectedConcern = identifyProtectedConcern(incident);
    // 2) owning system
    const owningSystem = identifyOwningSystem(incident);
    // 3) recall system truth
    const systemTruth = this._recallSystemTruth(owningSystem);

    // (optional) model advisory — NON-authoritative. Only attached, never decisive.
    let modelAdvisory = null;
    let escalation = null;
    if (input.useModel && this.ai) {
      const adv = await this.ai.governanceAdvisory({
        proposal: redactForModel(proposal),
        doctrine: this.doctrineText,
        sessionId,
      });
      if (adv.ok) modelAdvisory = adv.content;
      else escalation = adv.escalation; // circuit breaker / inference failure
    }

    // 4) evaluate authority via DETERMINISTIC engine (authoritative)
    const verdict = ruleEngine.evaluate(proposal, context, modelAdvisory);

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

    logger.info('diagnose_complete', {
      session_id: sessionId,
      classification: verdict.classification,
      requires_omstudio: verdict.requiresOmstudio,
    });

    return {
      session_id: sessionId,
      protected_concern: protectedConcern,
      owning_system: owningFromVerdict,
      system_truth_recalled: systemTruth,
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
