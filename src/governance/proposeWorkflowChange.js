'use strict';

/**
 * Constitutional Gate — agent-facing proposeWorkflowChange (PROC-001).
 *
 * Coding / architect / teaching agents MUST call this (or the Brain HTTP
 * wrapper) before designing, altering, or implementing a procedural system
 * workflow. It does NOT execute the workflow change.
 *
 * Production path (OMSTUDIO_TRANSPORT=http):
 *   POST Fork-A /api/governance/brain/workflow-proposals
 *   which runs the exact sequence on OMStudio (.242):
 *     1) write vault/docs/<slug>-proposal-v1.md
 *     2) insert om_library_records (is_canonical=0, tags include proposal)
 *        + om_documentation (draft, content_path)
 *     3) POST-equivalent createApproval → Brain Approvals UI (SUBMITTED)
 *
 * Dry-run path:
 *   Stages markdown under OMSTUDIO_OUTBOX_DIR/vault-docs/ and writes an
 *   approval outbox record — no Library mutation, no live approval.
 *
 * Gate hold: returns execution_allowed:false until a human superadmin
 * Approves the request in OMStudio. Canonical promotion (is_canonical=1)
 * remains a separate PROC-001 promotion step after Approve.
 */

const fs = require('fs');
const path = require('path');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || `workflow-proposal-${Date.now()}`;
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.description
 * @param {string} [input.risk_profile]
 * @param {string} [input.category]
 * @param {string|string[]} [input.tags]
 * @param {string} [input.markdown_body]
 * @param {string|object} [input.workflow_manifest]
 * @param {object} deps
 * @param {import('./omstudioClient').OmstudioClient} deps.omstudio
 * @param {boolean} [deps.dryRun]
 */
async function proposeWorkflowChange(input = {}, deps = {}) {
  const title = String(input.title || '').trim();
  const description = String(input.description || input.proposal_summary || '').trim();
  if (!title) {
    return { ok: false, error: 'title_required', execution_allowed: false };
  }
  if (!description) {
    return { ok: false, error: 'description_required', execution_allowed: false };
  }

  const omstudio = deps.omstudio || (deps.governance && deps.governance.omstudio);
  if (!omstudio) {
    return { ok: false, error: 'no_omstudio_client', execution_allowed: false };
  }

  const payload = {
    title,
    description,
    risk_profile: input.risk_profile || 'medium',
    category: input.category || 'OPERATIONS',
    tags: input.tags || ['proposal', 'workflow'],
    slug: input.slug || slugify(title),
    markdown_body: input.markdown_body || null,
    workflow_manifest: typeof input.workflow_manifest === 'object'
      ? JSON.stringify(input.workflow_manifest, null, 2)
      : (input.workflow_manifest || input.manifest || null),
    session_id: input.session_id || null,
    author_id: input.author_id || input.proposed_by || 'OM_AGENT',
    domains: input.domains || null,
    approval_local_id: input.approval_local_id || null,
    source_decision_id: input.source_decision_id ?? null,
  };

  const dryRun = !!deps.dryRun || omstudio.transport === 'dryrun';

  if (dryRun) {
    const outboxRoot = omstudio.outboxDir || './data/omstudio-outbox';
    const vaultStage = path.join(outboxRoot, 'vault-docs');
    fs.mkdirSync(vaultStage, { recursive: true });
    const filename = `${payload.slug}-proposal-v1.md`;
    const content_path = `vault/docs/${filename}`;
    const abs = path.join(vaultStage, filename);
    const body = payload.markdown_body || [
      `# ${title}`,
      '',
      description,
      '',
      '## Manifest',
      '',
      payload.workflow_manifest || '_none_',
      '',
    ].join('\n');
    fs.writeFileSync(abs, body, 'utf8');

    const approvalPayload = {
      approval_local_id: payload.approval_local_id || (Date.now() % 1000000000),
      session_id: payload.session_id || `workflow-proposal-${payload.slug}`,
      classification: 'requires_human_superadmin',
      domains: payload.domains || `workflow,${String(payload.category).toLowerCase()}`,
      proposal_summary: `[workflow_proposal:${payload.risk_profile}] ${title}`.slice(0, 500),
      change_kind: 'workflow_proposal',
      proposal_doc_path: content_path,
      content_path,
      library_record_id: null,
      documentation_slug: payload.slug,
      risk_profile: payload.risk_profile,
      title,
      description,
      gate: 'awaiting_superadmin_approve',
      execution_allowed: false,
      dry_run_staged_path: abs,
    };
    const submitted = await omstudio.submitApprovalRequest(approvalPayload);
    logger.info('propose_workflow_change_dryrun', {
      content_path,
      ref: submitted.ref,
    });
    return redactForLog({
      ok: !!submitted.ok,
      dry_run: true,
      gate: 'awaiting_superadmin_approve',
      execution_allowed: false,
      content_path,
      library_record_id: null,
      documentation_slug: payload.slug,
      is_canonical: 0,
      approval: { ref: submitted.ref || null, state: 'SUBMITTED', transport: submitted.transport },
      links: { content_path, approval_ref: submitted.ref || null },
      note: 'dryrun: vault staged in outbox; Library insert skipped until http transport',
    });
  }

  if (typeof omstudio.submitWorkflowProposal !== 'function') {
    return { ok: false, error: 'client_missing_submitWorkflowProposal', execution_allowed: false };
  }

  const result = await omstudio.submitWorkflowProposal(payload);
  return redactForLog({
    ...result,
    execution_allowed: false,
    gate: result.gate || 'awaiting_superadmin_approve',
  });
}

module.exports = {
  proposeWorkflowChange,
  slugify,
};
