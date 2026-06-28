'use strict';

/**
 * Mode router (master TODO §8 — Communication Modes).
 *
 * Sits ABOVE the subsystem classifier (src/modes/index.js). Where the subsystem
 * classifier answers "what is this about" (calendar / study / prayer / church /
 * pastoral / ops), the mode router answers "how should the Brain communicate":
 *
 *   - knowledge  : durable Orthodox knowledge (calendar, doctrine, prayer,
 *                  church, pastoral). Delegates to knowledgeHandler.
 *   - technical  : informational technical/platform questions. Delegates to
 *                  technicalHandler.
 *   - ops        : action-class operational requests (restart/deploy/etc.).
 *                  The orchestrator handles this lane itself via diagnose() so
 *                  the governance flow is enforced; the router only classifies.
 *
 * The orchestrator constructs this router and calls:
 *   - modeRouter.classifyIntent(query) -> 'knowledge' | 'technical' | 'ops'
 *   - modeRouter.routeQuery(query, { db, ai, sessionId, useModel }) for the
 *     knowledge/technical lanes (ops is short-circuited to diagnose()).
 */

const { handleKnowledge } = require('../handlers/knowledgeHandler');
const { handleTechnical } = require('../handlers/technicalHandler');

// Action-class operational verbs => the ops (governance) lane.
const OPS_ACTION_RE = /\b(restart|reboot|deploy|deployment|rollback|provision|stop|start service|kill|systemctl|service (down|status|failed|restart)|incident|outage|502|503|500|crash(ed|ing)?)\b/;

// Informational technical / platform signal words => the technical lane.
const TECHNICAL_RE = /\b(architecture|how does .* work|how is .* (configured|wired|deployed)|fleet health|server (status|health)|uptime|disk usage|cpu|memory usage|nginx|port \d+|which host|what runs on|infrastructure|topology|health\s*(check|status))\b/;

const MODES = Object.freeze([
  { id: 'knowledge', label: 'Knowledge', description: 'Durable Orthodox knowledge (calendar, doctrine, prayer, church, pastoral).' },
  { id: 'technical', label: 'Technical', description: 'Informational technical and platform questions.' },
  { id: 'ops', label: 'Operations', description: 'Action-class operational requests, routed through governance.' },
]);

class ModeRouter {
  /**
   * @param {object} [opts] { defaultMode }
   */
  constructor(opts = {}) {
    this.defaultMode = opts.defaultMode || 'knowledge';
  }

  /**
   * classifyIntent — map a free-text query to a communication mode.
   * Action verbs win first (safety: send anything actionable to governance),
   * then explicit technical signals, otherwise knowledge.
   */
  classifyIntent(query) {
    const q = String(query || '').toLowerCase();
    if (!q) return this.defaultMode;
    if (OPS_ACTION_RE.test(q)) return 'ops';
    if (TECHNICAL_RE.test(q)) return 'technical';
    return 'knowledge';
  }

  /**
   * routeQuery — execute the knowledge or technical lane. The ops lane is NOT
   * handled here (the orchestrator short-circuits ops to diagnose()).
   *
   * @param {string} query
   * @param {object} [ctx] { db, ai, sessionId, useModel, omaiProxyUrl, inventorySummary }
   */
  async routeQuery(query, ctx = {}) {
    const mode = this.classifyIntent(query);
    if (mode === 'technical') {
      return handleTechnical(query, { inventorySummary: ctx.inventorySummary });
    }
    // knowledge (and any non-ops fallback)
    return handleKnowledge(query, {
      db: ctx.db,
      ai: ctx.ai,
      sessionId: ctx.sessionId,
      omaiProxyUrl: ctx.omaiProxyUrl,
    });
  }

  listModes() {
    return MODES.slice();
  }

  modeMeta(id) {
    return MODES.find((m) => m.id === id) || null;
  }
}

module.exports = { ModeRouter, MODES };
