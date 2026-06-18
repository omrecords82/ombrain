'use strict';

/**
 * Governance manager — owns the OMStudio governance surface lifecycle.
 *
 * Responsibilities (Phase 1 governance-surface step):
 *   1. AUDIT: emit an audit event to OMStudio for EVERY decision (mirroring
 *      decision_memory) and mirror it locally in omstudio_audit (append-only).
 *   2. APPROVAL: for human-only / requires-superadmin classifications and Tier 0
 *      escalations, create an approval_request (PENDING_SUBMISSION), submit it
 *      to OMStudio (-> SUBMITTED), and persist an append-only status history.
 *   3. INGEST: apply an EXTERNALLY-sourced OMStudio status to an approval through
 *      the DETERMINISTIC approval state machine. The Brain can NEVER set
 *      APPROVED/REJECTED itself.
 *
 * Everything sent outbound is redacted; the OMStudio base URL is LAN-only
 * (enforced by the circuit breaker inside the client). The state machine is
 * authoritative and pure; the model has no influence here.
 */

const sm = require('./approvalStateMachine');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

// Classifications that REQUIRE an approval request be opened.
const APPROVAL_CLASSIFICATIONS = new Set([
  'requires_human_superadmin',
  'tier0_halt_escalate',
]);

class GovernanceManager {
  /**
   * @param {object} deps { db, omstudio }
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.omstudio = deps.omstudio; // OmstudioClient instance
  }

  requiresApproval(classification) {
    return APPROVAL_CLASSIFICATIONS.has(classification);
  }

  /**
   * Build a compact, REDACTED proposal summary string for the approval record.
   */
  _summarize(decision) {
    const base =
      `[${decision.classification}] ${decision.owning_system || 'unknown'}: ` +
      `${decision.recommendation || ''}`;
    // redactForLog on a string strips secret/tenant value patterns.
    return String(redactForLog(base)).slice(0, 500);
  }

  /**
   * Process a completed decision: always audit; conditionally open+submit an
   * approval request.
   *
   * @param {object} decision  the persisted decision record (incl. .id)
   * @param {object} verdict   the rule-engine verdict (for domains/tenant)
   * @returns {Promise<object>} governance result
   */
  async processDecision(decision, verdict) {
    const result = {
      audited: false,
      audit_ref: null,
      requires_human_superadmin_approval: false,
      omstudio_approval_ref: null,
      approval_id: null,
      approval_state: null,
    };

    // 1) AUDIT — every decision.
    try {
      const auditRecord = redactForLog({
        decision_id: decision.id || null,
        session_id: decision.session_id || null,
        classification: decision.classification,
        recommendation: decision.recommendation,
        rationale: decision.rationale,
        doctrine_rule: decision.doctrine_rule,
        owning_system: decision.owning_system,
        requires_omstudio: !!decision.requires_omstudio,
      });
      const emit = await this.omstudio.emitAuditEvent(auditRecord);
      result.audited = !!emit.ok;
      result.audit_ref = emit.ref || null;
      if (this.db) {
        this.db.appendOmstudioAudit({
          kind: 'audit_event',
          source_decision_id: decision.id || null,
          classification: decision.classification,
          transport: emit.transport,
          omstudio_ref: emit.ref || null,
          payload_json: JSON.stringify(auditRecord),
        });
      }
    } catch (e) {
      logger.warn('governance_audit_error', { name: e && e.name });
    }

    // 2) APPROVAL — only for human-only / Tier 0.
    if (this.requiresApproval(decision.classification)) {
      result.requires_human_superadmin_approval = true;

      const domains = (verdict && verdict.domains) ? verdict.domains.join(',') : null;
      const summary = this._summarize(decision);

      // 2a) create at PENDING_SUBMISSION (append-only history seeded by db).
      let approvalId = null;
      if (this.db) {
        approvalId = this.db.createApprovalRequest({
          source_decision_id: decision.id || null,
          session_id: decision.session_id || null,
          classification: decision.classification,
          domains,
          proposal_summary: summary,
          state: sm.STATES.PENDING_SUBMISSION,
        });
      }
      result.approval_id = approvalId;
      result.approval_state = sm.STATES.PENDING_SUBMISSION;

      // 2b) submit to OMStudio (records to outbox in dry-run).
      const submitPayload = redactForLog({
        approval_local_id: approvalId,
        source_decision_id: decision.id || null,
        session_id: decision.session_id || null,
        classification: decision.classification,
        domains,
        proposal_summary: summary,
      });
      const submitted = await this.omstudio.submitApprovalRequest(submitPayload);

      // mirror submission in audit
      if (this.db) {
        this.db.appendOmstudioAudit({
          kind: 'approval_request',
          source_decision_id: decision.id || null,
          classification: decision.classification,
          transport: submitted.transport,
          omstudio_ref: submitted.ref || null,
          payload_json: JSON.stringify(submitPayload),
        });
      }

      // 2c) advance PENDING_SUBMISSION -> SUBMITTED via the state machine.
      if (submitted.ok && approvalId != null) {
        const t = sm.canTransition(
          sm.STATES.PENDING_SUBMISSION,
          sm.STATES.SUBMITTED,
          sm.SOURCES.BRAIN_SUBMIT,
        );
        if (t.ok && this.db) {
          this.db.advanceApprovalState({
            approval_id: approvalId,
            from_state: sm.STATES.PENDING_SUBMISSION,
            to_state: sm.STATES.SUBMITTED,
            source: sm.SOURCES.BRAIN_SUBMIT,
            note: 'submitted to OMStudio governance surface',
            omstudio_ref: submitted.ref || null,
          });
          result.approval_state = sm.STATES.SUBMITTED;
        }
      }
      result.omstudio_approval_ref = submitted.ref || null;
    }

    return result;
  }

  /**
   * Ingest an EXTERNALLY-sourced status for an approval request. This is the ONLY
   * path that can move an approval to APPROVED/REJECTED/EXPIRED. The Brain itself
   * cannot call this with a brain source for those states (the state machine
   * rejects it).
   *
   * @param {number} approvalId
   * @param {object} input { decision, source, note, omstudio_ref }
   *        decision: external decision string (approved|rejected|expired|withdrawn)
   *        source:   'omstudio_ingest' (live webhook) | 'dryrun_sim' (test-only)
   * @returns {{ ok:boolean, reason:string, from?:string, to?:string, state?:string }}
   */
  ingestStatus(approvalId, input = {}) {
    if (!this.db) return { ok: false, reason: 'no_db' };
    const row = this.db.getApprovalRequest(approvalId);
    if (!row) return { ok: false, reason: 'approval_not_found' };

    const source = input.source === 'dryrun_sim' ? sm.SOURCES.DRYRUN_SIM : sm.SOURCES.OMSTUDIO_INGEST;
    const toState = sm.mapExternalDecision(input.decision);
    if (!toState) return { ok: false, reason: 'unrecognized_external_decision' };

    const from = row.state;
    const check = sm.canTransition(from, toState, source);
    if (!check.ok) {
      logger.warn('approval_transition_rejected', { from, to: toState, reason: check.reason });
      return { ok: false, reason: check.reason, from, to: toState };
    }

    this.db.advanceApprovalState({
      approval_id: approvalId,
      from_state: from,
      to_state: toState,
      source,
      note: input.note ? String(redactForLog(input.note)).slice(0, 500) : null,
      omstudio_ref: input.omstudio_ref || row.omstudio_ref || null,
    });

    logger.info('approval_status_ingested', { approval_id: approvalId, from, to: toState, source });
    return { ok: true, reason: 'ok', from, to: toState, state: toState };
  }
}

module.exports = { GovernanceManager, APPROVAL_CLASSIFICATIONS };
