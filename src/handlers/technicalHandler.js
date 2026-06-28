'use strict';

/**
 * Technical handler (master TODO §8).
 *
 * The "technical" communication mode covers informational technical and
 * platform questions — system architecture, how a service is wired, fleet
 * health, "what does X do" — that are read-only and do NOT propose an
 * infrastructure change. Action-class requests (restart/deploy/rollback) are
 * the `ops` lane and must go through the governance flow via the orchestrator's
 * diagnose() path; this handler defers to it by delegating to handleOps, which
 * already flags action-class requests as requiring governance.
 */

const { handleOps } = require('../queryPipeline/pipeline');

const MODE_LABEL = 'Technical';
const MODE_DESCRIPTION =
  'Informational technical and platform questions (architecture, service '
  + 'wiring, fleet health). Action requests are routed through governance.';

/**
 * handleTechnical — answer an informational technical query.
 *
 * @param {string} query
 * @param {object} [opts] { inventorySummary }
 * @returns {Promise<object>} { ok, mode_label, mode_description, answer, detail }
 */
async function handleTechnical(query, opts = {}) {
  const q = String(query || '').trim();
  const detail = await handleOps(q, { inventorySummary: opts.inventorySummary || null });
  return {
    ok: true,
    mode: 'technical',
    mode_label: MODE_LABEL,
    mode_description: MODE_DESCRIPTION,
    requires_governance: !!detail.requiresGovernance,
    answer: detail && detail.answer,
    detail,
  };
}

module.exports = { handleTechnical, MODE_LABEL, MODE_DESCRIPTION };
