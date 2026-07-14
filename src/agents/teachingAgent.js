'use strict';

/**
 * OMBrain Teaching Agent v1 — strict Skill/Procedure Compiler.
 *
 * NEVER executes infrastructure. Only proposes, validates, serializes, and
 * submits structured skill/procedure definitions. OMBrain, RuleEngine,
 * skillSafety.js, and OMStudio governance remain authoritative.
 */

const crypto = require('crypto');
const sm = require('../governance/approvalStateMachine');
const ruleEngine = require('../governance/ruleEngine');
const { redactForLog } = require('../ai/redactor');
const { normalizeSkillKey } = require('../skills/skillSafety');
const logger = require('../util/logger');
const {
  MANIFEST_TYPE,
  VALID_CATEGORIES,
  validateTeachingManifest,
  validateTeachingInput,
} = require('./teachingAgentSchema');

const DEFAULT_FORBIDDEN = [
  'direct_shell_execution',
  'autonomous_remediation',
  'credential_exfiltration',
  'cross_server_fleet_scan_without_approval',
  'db_mutation',
  'deploy_without_governance',
  'bypass_rule_engine',
  'bypass_skill_safety',
];

/**
 * Infer risk level from input and compiled content.
 */
function inferRiskLevel(input, manifestText) {
  if (input.risk_hint && ['low', 'medium', 'high', 'destructive'].includes(input.risk_hint)) {
    return input.risk_hint;
  }
  const blob = String(manifestText || '').toLowerCase();
  if (/\b(destructive|delete all|rm -rf|drop table)\b/.test(blob)) return 'destructive';
  if (/\b(deploy|restart|mutation|firewall|fleet)\b/.test(blob)) return 'high';
  if (/\b(diagnose|verify|check|read-only|search|list)\b/.test(blob)) return 'low';
  return 'medium';
}

/**
 * Build deterministic steps from input when not pre-supplied.
 */
function buildDeterministicSteps(input) {
  if (Array.isArray(input.deterministic_steps) && input.deterministic_steps.length) {
    return input.deterministic_steps;
  }
  const steps = [
    { step: 1, action: `Review goal: ${input.goal}`, kind: 'review' },
  ];
  if (input.proposed_scope) {
    steps.push({ step: 2, action: `Scope: ${input.proposed_scope}`, kind: 'scope' });
  }
  if (input.evidence) {
    const ev = Array.isArray(input.evidence) ? input.evidence.join('; ') : String(input.evidence);
    steps.push({ step: steps.length + 1, action: `Evidence: ${ev.slice(0, 500)}`, kind: 'evidence' });
  }
  steps.push({
    step: steps.length + 1,
    action: 'Return structured findings to operator; do not execute remediation',
    kind: 'output',
  });
  return steps;
}

/**
 * Compile a teaching input into a skill_proposal manifest (deterministic).
 * LLM may only enrich model_advisory_steps when aiClient provided and allowed.
 *
 * @param {object} input — { source, goal, evidence, proposed_scope, risk_hint, ... }
 * @param {object} [opts] — { aiClient, sessionId }
 * @returns {Promise<object>} manifest
 */
async function compileProposal(input, opts = {}) {
  const inputCheck = validateTeachingInput(input);
  if (!inputCheck.ok) {
    const err = new Error('invalid_teaching_input');
    err.code = 'invalid_teaching_input';
    err.details = inputCheck.errors;
    throw err;
  }

  const name = normalizeSkillKey(input.name || input.goal);
  const category = input.category && VALID_CATEGORIES.has(input.category)
    ? input.category
    : (input.proposed_scope && /proposal|human/i.test(input.proposed_scope) ? 'proposal' : 'knowledge');

  const deterministic_steps = buildDeterministicSteps(input);
  let model_advisory_steps = Array.isArray(input.model_advisory_steps) ? input.model_advisory_steps : [];

  if (model_advisory_steps.length === 0 && opts.aiClient && typeof opts.aiClient._chat === 'function') {
    try {
      const messages = [
        {
          role: 'system',
          content:
            'You are a teaching assistant for OMBrain. Suggest ONLY advisory analysis steps. ' +
            'Never suggest shell execution, deploy, restart, DB writes, or credential access. ' +
            'Return a JSON array of short strings, max 5 items.',
        },
        {
          role: 'user',
          content: `Goal: ${input.goal}\nScope: ${input.proposed_scope || 'unspecified'}\nEvidence: ${JSON.stringify(input.evidence || '')}`,
        },
      ];
      const resp = await opts.aiClient._chat({
        model: undefined,
        messages,
        sessionId: opts.sessionId || 'teaching-agent',
        kind: 'teaching_advisory',
      });
      if (resp && resp.ok && resp.content) {
        const parsed = JSON.parse(resp.content.replace(/^[^[]*/, '').replace(/[^\]]*$/, ''));
        if (Array.isArray(parsed)) {
          model_advisory_steps = parsed.filter((s) => typeof s === 'string').slice(0, 5);
        }
      }
    } catch (e) {
      logger.warn('teaching_agent_llm_advisory_skip', { name: e && e.name });
    }
  }

  if (model_advisory_steps.length === 0) {
    model_advisory_steps = [
      'Summarize relevant doctrine and prior corrections for this goal',
      'Identify gaps in local memory before recommending new procedures',
    ];
  }

  const manifestText = [
    input.goal,
    input.proposed_scope,
    JSON.stringify(deterministic_steps),
    JSON.stringify(model_advisory_steps),
  ].join(' ');

  const risk_level = inferRiskLevel(input, manifestText);
  const human_gated_action = !!(
    input.human_gated_action ||
    (input.proposed_scope && /human[-_\s]?gated|proposal[-_\s]?only|operator approval/i.test(input.proposed_scope))
  );

  const governance_required = risk_level !== 'low' || human_gated_action || !!input.script_body;

  const manifest = {
    type: MANIFEST_TYPE,
    name,
    description: input.description || input.goal,
    category,
    risk_level,
    allowed_inputs: Array.isArray(input.allowed_inputs)
      ? input.allowed_inputs
      : ['source', 'goal', 'evidence', 'proposed_scope'],
    required_context: Array.isArray(input.required_context)
      ? input.required_context
      : ['om_doctrine', 'rule_engine_verdict'],
    deterministic_steps,
    model_advisory_steps,
    forbidden_actions: Array.isArray(input.forbidden_actions) ? input.forbidden_actions : [...DEFAULT_FORBIDDEN],
    governance_required,
    verification_steps: Array.isArray(input.verification_steps)
      ? input.verification_steps
      : [
        'Schema validation passes',
        'skillSafety passes if script_body present',
        'RuleEngine classification reviewed',
      ],
    rollback_or_disable_plan: input.rollback_or_disable_plan ||
      `Deactivate procedure slug "${name}" via POST /brain/procedures/${name}/reject or db.deactivateSkill if promoted to skill_memory`,
    human_gated_action,
    source: input.source,
    compiled_at: new Date().toISOString(),
  };

  if (input.script_body) {
    manifest.script_body = input.script_body;
    manifest.language = input.language || 'bash';
  }

  if (input.tags) manifest.tags = input.tags;

  return manifest;
}

/**
 * Validate manifest — schema + skillSafety + forbidden action scan.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], governance_required: boolean, human_gated_required: boolean }}
 */
function validateManifest(manifest) {
  return validateTeachingManifest(manifest);
}

/**
 * Check RuleEngine — corrections and teaching proposals cannot override gates.
 */
function evaluateGovernanceClass(manifest) {
  const proposal = {
    action: manifest.script_body ? 'skill_register' : 'procedure_register',
    description: manifest.description,
    domain: manifest.category,
  };
  const verdict = ruleEngine.evaluate(proposal, {}, null);
  return verdict;
}

/**
 * Store pending proposal in procedure_memory (approved=0 unless low-risk auto path).
 */
function storeProposal(db, manifest, { autoApproveLow = false } = {}) {
  if (!db || typeof db.upsertProcedure !== 'function') {
    throw new Error('no_db');
  }

  const slug = normalizeSkillKey(manifest.name);
  const existing = db.getProcedureBySlug(slug);
  const id = (existing && existing.id) || crypto.randomUUID();

  const validation = validateManifest(manifest);
  const approved = autoApproveLow &&
    manifest.risk_level === 'low' &&
    !validation.governance_required &&
    !validation.human_gated_required;

  db.upsertProcedure({
    id,
    slug,
    title: manifest.description.slice(0, 200),
    intent_key: slug,
    mode: manifest.category === 'ops' ? 'ops' : (manifest.category === 'diagnostic' ? 'technical' : 'knowledge'),
    trigger_examples: JSON.stringify([manifest.description.slice(0, 120)]),
    procedure_body: JSON.stringify(manifest),
    commands_json: JSON.stringify({
      type: MANIFEST_TYPE,
      deterministic_steps: manifest.deterministic_steps,
      forbidden_actions: manifest.forbidden_actions,
    }),
    risk_level: manifest.risk_level,
    validation_steps: JSON.stringify(manifest.verification_steps),
    source_decision_id: null,
    source_type: 'teaching_agent',
    confidence: approved ? 0.9 : 0.0,
    approved: approved ? 1 : 0,
    approved_by: approved ? 'teaching_agent_auto_low' : null,
    usage_count: 0,
  });

  return { id, slug, approved: !!approved };
}

/**
 * Submit OMStudio governance for medium/high or action-capable proposals.
 * Procedure / workflow / OPERATIONS proposals route through the PROC-001
 * Constitutional Gate (`proposeWorkflowChange`) so they cannot execute
 * until a superadmin Approves in OMStudio.
 */
async function submitGovernance(governance, manifest, stored, sessionId) {
  if (!governance || !governance.omstudio) {
    return { submitted: false, reason: 'no_governance' };
  }

  const classification = 'requires_human_superadmin';
  const summary = `[teaching_agent:${manifest.risk_level}] ${manifest.name}: ${manifest.description}`.slice(0, 500);
  const domains = manifest.category;
  const procedural = /^(proposal|operations|procedure|workflow)$/i.test(String(manifest.category || ''))
    || /workflow|procedure|process/i.test(String(manifest.name || ''))
    || !!manifest.proc001;

  let approvalId = null;
  if (governance.db) {
    approvalId = governance.db.createApprovalRequest({
      source_decision_id: null,
      session_id: sessionId || null,
      classification,
      domains,
      proposal_summary: summary,
      state: sm.STATES.PENDING_SUBMISSION,
    });
  }

  let submitted;
  let constitutional = null;

  if (procedural) {
    const { proposeWorkflowChange } = require('../governance/proposeWorkflowChange');
    constitutional = await proposeWorkflowChange({
      title: manifest.name || stored.slug,
      description: manifest.description || summary,
      risk_profile: manifest.risk_level || 'medium',
      category: 'OPERATIONS',
      tags: ['proposal', 'workflow', 'teaching_agent', String(manifest.category || 'proposal')],
      slug: stored.slug || manifest.name,
      workflow_manifest: manifest,
      session_id: sessionId || null,
      author_id: 'teaching_agent',
      approval_local_id: approvalId,
      domains: `workflow,teaching,${domains || 'proposal'}`,
    }, { omstudio: governance.omstudio });
    submitted = {
      ok: !!(constitutional && constitutional.ok),
      ref: (constitutional && constitutional.approval && constitutional.approval.ref)
        || (constitutional && constitutional.links && constitutional.links.approval_ref)
        || null,
      transport: governance.omstudio.transport,
    };
  } else {
    const submitPayload = redactForLog({
      approval_local_id: approvalId,
      teaching_proposal_id: stored.id,
      teaching_proposal_slug: stored.slug,
      session_id: sessionId || null,
      classification,
      domains,
      proposal_summary: summary,
      manifest_name: manifest.name,
      risk_level: manifest.risk_level,
    });
    submitted = await governance.omstudio.submitApprovalRequest(submitPayload);
  }

  if (governance.db) {
    governance.db.appendOmstudioAudit({
      kind: procedural ? 'teaching_workflow_proposal' : 'teaching_proposal',
      source_decision_id: stored.id,
      classification,
      transport: submitted.transport,
      omstudio_ref: submitted.ref || null,
      payload_json: JSON.stringify(redactForLog(constitutional || { summary })),
    });
  }

  if (submitted.ok && approvalId != null && governance.db) {
    const t = sm.canTransition(sm.STATES.PENDING_SUBMISSION, sm.STATES.SUBMITTED, sm.SOURCES.BRAIN_SUBMIT);
    if (t.ok) {
      governance.db.advanceApprovalState({
        approval_id: approvalId,
        from_state: sm.STATES.PENDING_SUBMISSION,
        to_state: sm.STATES.SUBMITTED,
        source: sm.SOURCES.BRAIN_SUBMIT,
        note: procedural
          ? 'teaching agent PROC-001 workflow proposal submitted to OMStudio'
          : 'teaching agent skill proposal submitted to OMStudio',
        omstudio_ref: submitted.ref || null,
      });
    }
  }

  return {
    submitted: !!submitted.ok,
    approval_id: approvalId,
    omstudio_ref: submitted.ref || null,
    approval_state: submitted.ok ? sm.STATES.SUBMITTED : sm.STATES.PENDING_SUBMISSION,
    constitutional_gate: procedural ? (constitutional || { ok: false }) : null,
    execution_allowed: false,
  };
}

/**
 * Full pipeline: compile (optional), validate, store, governance.
 *
 * @param {object} input — teaching request or pre-built manifest
 * @param {object} deps — { db, governance, aiClient, sessionId, submit, dryRun }
 */
async function processTeachingRequest(input, deps = {}) {
  const dryRun = !!deps.dryRun;
  const submit = deps.submit !== false && !dryRun;

  let manifest = input;
  if (input.type !== MANIFEST_TYPE) {
    manifest = await compileProposal(input, { aiClient: deps.aiClient, sessionId: deps.sessionId });
  }

  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return {
      ok: false,
      dry_run: dryRun,
      error: 'validation_failed',
      errors: validation.errors,
      warnings: validation.warnings,
      manifest: redactForLog(manifest),
    };
  }

  const ruleVerdict = evaluateGovernanceClass(manifest);
  if (ruleVerdict.classification === 'never_auto' || ruleVerdict.classification === 'tier0_halt_escalate') {
    return {
      ok: false,
      dry_run: dryRun,
      error: 'rule_engine_blocked',
      classification: ruleVerdict.classification,
      domains: ruleVerdict.domains,
      manifest: redactForLog(manifest),
    };
  }

  manifest.governance_required = validation.governance_required;

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      manifest: redactForLog(manifest),
      validation,
      rule_verdict: ruleVerdict,
      governance_required: validation.governance_required,
      would_store: true,
      would_submit_governance: validation.governance_required,
    };
  }

  if (!submit) {
    return {
      ok: true,
      dry_run: true,
      manifest: redactForLog(manifest),
      validation,
      rule_verdict: ruleVerdict,
      governance_required: validation.governance_required,
    };
  }

  const autoApproveLow = manifest.risk_level === 'low' && !validation.governance_required;
  const stored = storeProposal(deps.db, manifest, { autoApproveLow });

  let governanceResult = null;
  if (validation.governance_required) {
    governanceResult = await submitGovernance(deps.governance, manifest, stored, deps.sessionId);
  }

  if (manifest.script_body && stored.approved && deps.db && typeof deps.db.upsertSkill === 'function') {
    const { validateSkillScript } = require('../skills/skillSafety');
    const safety = validateSkillScript({ script_body: manifest.script_body, language: manifest.language });
    if (safety.ok) {
      deps.db.upsertSkill({
        id: crypto.randomUUID(),
        skill_key: stored.slug,
        title: manifest.description.slice(0, 200),
        description: manifest.description,
        language: manifest.language,
        script_body: manifest.script_body,
        tags_json: manifest.tags ? JSON.stringify(manifest.tags) : null,
        source: 'teaching_agent',
        version: 1,
        active: 1,
      });
    }
  }

  logger.info('teaching_proposal_stored', {
    slug: stored.slug,
    approved: stored.approved,
    governance: !!governanceResult && governanceResult.submitted,
  });

  return {
    ok: true,
    dry_run: false,
    manifest: redactForLog(manifest),
    stored: {
      id: stored.id,
      slug: stored.slug,
      approved: stored.approved,
      active: stored.approved,
    },
    validation,
    rule_verdict: ruleVerdict,
    governance_required: validation.governance_required,
    governance: governanceResult,
  };
}

module.exports = {
  compileProposal,
  validateManifest,
  evaluateGovernanceClass,
  storeProposal,
  submitGovernance,
  processTeachingRequest,
  inferRiskLevel,
  DEFAULT_FORBIDDEN,
};
