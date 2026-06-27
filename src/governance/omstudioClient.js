'use strict';

/**
 * OMStudio governance client — VERIFIED CONTRACT (P2 patch).
 *
 * Replaces the ASSUMED_PATHS block with the paths confirmed by reading:
 *   - omai/packages/omstudio-brain-governance/src/routes/brainGovernance.js
 *   - omai/packages/omstudio-brain-governance/README.md
 *   - omai/packages/omstudio-brain-governance/src/util/config.js
 *   - omai/omstudio/_runtime/server/src/index.js  (app.use mounts)
 *
 * VERIFIED routing truth:
 *   OMStudio Express app binds on .242:4070 (127.0.0.1 only).
 *   The .242 nginx edge maps:
 *     /omstudio-embed/api/governance/brain/*  →  127.0.0.1:4070/api/governance/brain/*
 *   The Brain targets the edge base (OMSTUDIO_GOVERNANCE_BASE_URL), so the
 *   /omstudio-embed prefix is correct for the Brain's outbound calls.
 *
 * VERIFIED inbound webhook:
 *   OMStudio calls POST http://<auth01>:8390/governance/approvals/:id/ingest-status
 *   (port 8390 — the Brain's confirmed default; the governance package README/config
 *   incorrectly documented :8391; that is a bug in the package, fixed in P2).
 *
 * NEW in P2:
 *   - ASSUMED_PATHS → VERIFIED_PATHS (comment updated, paths unchanged — they were correct)
 *   - Inbound webhook-secret validation helper (validateWebhookSecret)
 *   - OMSTUDIO_WEBHOOK_SECRET env var wired into Brain server.js (see server.js patch)
 *   - getApprovalStatus now returns the full history array from the polling response
 *   - Polling fallback: if state is null (terminal or unknown), logs a warning
 *
 * Adapter interface (stable; transports are swappable):
 *   - emitAuditEvent(record)           -> { ok, ref, transport }
 *   - submitApprovalRequest(proposal)  -> { ok, ref, transport }
 *   - getApprovalStatus(ref)           -> { ok, state|null, history, raw }
 *
 * Doctrine guarantees (unchanged):
 *   - LAN/allowed-host ONLY: circuit breaker refuses external hosts.
 *   - REDACT BEFORE EGRESS: every outbound payload passes through redactForLog.
 *   - Service token is Bearer-header only; never in payload, never logged.
 */

const fs = require('fs');
const path = require('path');
const breaker = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

// ---- VERIFIED OMStudio REST paths -------------------------------------------
// Source: omai/packages/omstudio-brain-governance/src/routes/brainGovernance.js
// Edge:   .242 nginx maps /omstudio-embed/api/governance/brain/* → :4070/api/governance/brain/*
// The Brain targets the edge base, so these /omstudio-embed-prefixed paths are correct.
const VERIFIED_PATHS = Object.freeze({
  audit:          '/omstudio-embed/api/governance/brain/audit-events',
  approvals:      '/omstudio-embed/api/governance/brain/approval-requests',
  approvalStatus: '/omstudio-embed/api/governance/brain/approval-requests/:ref',
  health:         '/omstudio-embed/api/governance/brain/health',
});

// Keep the old export name so existing code that imports ASSUMED_PATHS still works.
// Callers should migrate to VERIFIED_PATHS.
const ASSUMED_PATHS = VERIFIED_PATHS;

class OmstudioClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl          OMStudio governance base URL (.242 edge)
   * @param {string} opts.serviceToken     governed service token (never logged)
   * @param {('dryrun'|'http')} opts.transport
   * @param {string} opts.outboxDir        dir for dry-run outbox
   * @param {boolean} opts.production
   * @param {Function} [opts.httpImpl]     injectable fetch for tests
   * @param {Function} [opts.now]          injectable clock for tests
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || '';
    this.serviceToken = opts.serviceToken || '';
    this.transport = opts.transport === 'http' ? 'http' : 'dryrun';
    this.outboxDir = opts.outboxDir || './data/omstudio-outbox';
    this.production = !!opts.production;
    this.http = opts.httpImpl || globalThis.fetch;
    this.now = opts.now || (() => new Date());
    this.paths = VERIFIED_PATHS;
  }

  /**
   * Circuit-breaker check for the configured OMStudio base URL.
   * @returns {{ allowed: boolean, reason: string, host: string }}
   */
  checkEndpoint() {
    if (this.transport === 'dryrun' && !this.baseUrl) {
      return { allowed: true, reason: 'dryrun_no_base_url', host: '' };
    }
    return breaker.checkHost(this.baseUrl, { production: this.production });
  }

  _ensureOutbox() {
    if (!fs.existsSync(this.outboxDir)) fs.mkdirSync(this.outboxDir, { recursive: true });
  }

  _ref(kind) {
    const ts = this.now().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${this.transport}-${kind}-${ts}-${rand}`;
  }

  /**
   * Write a record to the dry-run outbox (one JSON file per record).
   * Payload is assumed already redacted by the caller; we redact again defensively.
   */
  _writeOutbox(kind, payload) {
    this._ensureOutbox();
    const ref = this._ref(kind);
    const safe = redactForLog(payload);
    const file = path.join(this.outboxDir, ref + '.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ kind, ref, written_at: this.now().toISOString(), payload: safe }, null, 2),
    );
    return { ref, file, safe };
  }

  /**
   * Perform an HTTP POST/GET to OMStudio. Enforces the circuit breaker and
   * redacts the body before send. The service token is attached as a bearer
   * header only and never logged.
   */
  async _httpSend(method, url, bodyObj) {
    const verdict = this.checkEndpoint();
    if (!verdict.allowed) {
      const err = new Error('omstudio_endpoint_blocked:' + verdict.reason);
      err.code = 'CIRCUIT_BREAKER';
      err.verdict = verdict;
      throw err;
    }
    if (!this.http) {
      const err = new Error('no_http_impl');
      err.code = 'NO_HTTP';
      throw err;
    }
    const headers = { Accept: 'application/json' };
    if (this.serviceToken) headers.Authorization = `Bearer ${this.serviceToken}`;
    let body;
    if (bodyObj !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(redactForLog(bodyObj)); // REDACT BEFORE EGRESS
    }
    const res = await this.http(url, { method, headers, body });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { raw: text };
    }
    return { status: res.status, ok: res.ok, json };
  }

  _url(pathname, ref) {
    let p = pathname;
    if (ref) p = p.replace(':ref', encodeURIComponent(ref));
    return new URL(p, this.baseUrl).toString();
  }

  // ---------------------------------------------------------------------------
  // (a) AUDIT EVENT
  // ---------------------------------------------------------------------------
  /**
   * Emit an audit event mirroring a decision. `record` is the decision-shaped
   * object; it is redacted before egress.
   *
   * Verified endpoint: POST /omstudio-embed/api/governance/brain/audit-events
   * Auth:              Authorization: Bearer <OMSTUDIO_SERVICE_TOKEN>
   *                    (scope: write:brain-audit)
   * Response:          { id, ref, received_at }  HTTP 201
   *
   * @returns {Promise<{ok:boolean, ref:string|null, transport:string, blocked?:boolean, reason?:string}>}
   */
  async emitAuditEvent(record) {
    const payload = redactForLog({
      type: 'brain_audit_event',
      emitted_at: this.now().toISOString(),
      decision: record,
    });

    if (this.transport === 'dryrun') {
      const { ref } = this._writeOutbox('audit', payload);
      logger.info('omstudio_audit_dryrun', { ref });
      return { ok: true, ref, transport: 'dryrun' };
    }

    try {
      const r = await this._httpSend('POST', this._url(this.paths.audit), payload);
      const ref = (r.json && (r.json.ref || r.json.id)) || null;
      logger.info('omstudio_audit_http', { status: r.status, ok: r.ok });
      return { ok: r.ok, ref, transport: 'http' };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        logger.warn('omstudio_audit_blocked', { reason: e.verdict && e.verdict.reason });
        return { ok: false, ref: null, transport: 'http', blocked: true, reason: e.verdict.reason };
      }
      logger.warn('omstudio_audit_error', { name: e && e.name });
      return { ok: false, ref: null, transport: 'http', reason: 'transport_error' };
    }
  }

  // ---------------------------------------------------------------------------
  // (b) APPROVAL REQUEST
  // ---------------------------------------------------------------------------
  /**
   * Submit an approval request.
   *
   * Verified endpoint: POST /omstudio-embed/api/governance/brain/approval-requests
   * Auth:              Authorization: Bearer <OMSTUDIO_SERVICE_TOKEN>
   *                    (scope: write:brain-approvals)
   * Request body:      { type, submitted_at, request: { approval_local_id, source_decision_id,
   *                      session_id, classification, domains, proposal_summary } }
   * Response:          { id, ref, state: 'SUBMITTED' }  HTTP 201
   *
   * The returned `ref` is the OMStudio approval ref. The Brain stores it as
   * `omstudio_ref` in the local approval record so the inbound webhook can
   * correlate the decision back to the correct local approval.
   *
   * @returns {Promise<{ok:boolean, ref:string|null, transport:string}>}
   */
  async submitApprovalRequest(proposal) {
    const payload = redactForLog({
      type: 'brain_approval_request',
      submitted_at: this.now().toISOString(),
      request: proposal,
    });

    if (this.transport === 'dryrun') {
      const { ref } = this._writeOutbox('approval', payload);
      logger.info('omstudio_approval_dryrun', { ref });
      return { ok: true, ref, transport: 'dryrun' };
    }

    try {
      const r = await this._httpSend('POST', this._url(this.paths.approvals), payload);
      const ref = (r.json && (r.json.ref || r.json.id)) || null;
      logger.info('omstudio_approval_http', { status: r.status, ok: r.ok, ref });
      return { ok: r.ok, ref, transport: 'http' };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        logger.warn('omstudio_approval_blocked', { reason: e.verdict && e.verdict.reason });
        return { ok: false, ref: null, transport: 'http', blocked: true, reason: e.verdict.reason };
      }
      logger.warn('omstudio_approval_error', { name: e && e.name });
      return { ok: false, ref: null, transport: 'http', reason: 'transport_error' };
    }
  }

  // ---------------------------------------------------------------------------
  // (c) APPROVAL STATUS POLL (fallback — primary path is the inbound webhook)
  // ---------------------------------------------------------------------------
  /**
   * Poll OMStudio for the current state + history of an approval request.
   *
   * Verified endpoint: GET /omstudio-embed/api/governance/brain/approval-requests/:ref
   * Auth:              Authorization: Bearer <OMSTUDIO_SERVICE_TOKEN>
   * Response:          { ref, state, history: [...] }
   *
   * In dry-run there is no remote state to poll (decisions arrive via the
   * ingest-status webhook), so returns state: null.
   *
   * @returns {Promise<{ok:boolean, state:string|null, history:Array, raw:object}>}
   */
  async getApprovalStatus(ref) {
    if (this.transport === 'dryrun') {
      return {
        ok: true,
        state: null,
        history: [],
        raw: { note: 'dryrun: status arrives via ingest-status webhook' },
      };
    }
    try {
      const r = await this._httpSend('GET', this._url(this.paths.approvalStatus, ref));
      const state = r.json && r.json.state ? String(r.json.state) : null;
      const history = (r.json && Array.isArray(r.json.history)) ? r.json.history : [];
      if (r.ok && !state) {
        logger.warn('omstudio_approval_poll_no_state', { ref });
      }
      return { ok: r.ok, state, history, raw: redactForLog(r.json) };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        return { ok: false, state: null, history: [], blocked: true, reason: e.verdict.reason };
      }
      return { ok: false, state: null, history: [], reason: 'transport_error' };
    }
  }

  // ---------------------------------------------------------------------------
  // (d) GOVERNANCE HEALTH CHECK
  // ---------------------------------------------------------------------------
  /**
   * Ping the OMStudio governance surface. Useful for startup checks and auditor
   * loop health assertions.
   *
   * Verified endpoint: GET /omstudio-embed/api/governance/brain/health
   * Auth:              none (unauthenticated liveness)
   *
   * @returns {Promise<{ok:boolean, transport:string}>}
   */
  async checkGovernanceHealth() {
    if (this.transport === 'dryrun') {
      return { ok: true, transport: 'dryrun' };
    }
    try {
      const r = await this._httpSend('GET', this._url(this.paths.health));
      return { ok: r.ok, transport: 'http', status: r.status };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        return { ok: false, transport: 'http', blocked: true, reason: e.verdict.reason };
      }
      return { ok: false, transport: 'http', reason: 'transport_error' };
    }
  }

  // ---------------------------------------------------------------------------
  // Query poll surface (Phase 10) — pending user queries from OMStudio
  // ---------------------------------------------------------------------------

  async fetchPendingQueries(_limit = 10) {
    if (this.transport === 'dryrun') return [];
    try {
      const r = await this._httpSend('GET', this._url('/omstudio-embed/api/governance/brain/pending-queries'));
      const rows = r.json && (r.json.queries || r.json.items);
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  async acknowledgeQuery(_queryId) {
    return { ok: true };
  }

  async reportQueryResult(_queryId, _payload) {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook-secret validation (used by server.js ingest-status endpoint)
// ---------------------------------------------------------------------------
/**
 * Validate the X-OM-Webhook-Secret header on an inbound OMStudio webhook call.
 *
 * The secret is configured via OMSTUDIO_WEBHOOK_SECRET env var on the Brain.
 * If the env var is empty, validation is skipped (development/dry-run mode).
 *
 * @param {string} headerValue   value of req.headers['x-om-webhook-secret']
 * @param {string} configSecret  process.env.OMSTUDIO_WEBHOOK_SECRET
 * @returns {{ ok: boolean, reason: string }}
 */
function validateWebhookSecret(headerValue, configSecret) {
  if (!configSecret) {
    // No secret configured — skip validation (dev/dry-run).
    return { ok: true, reason: 'no_secret_configured' };
  }
  if (!headerValue) {
    return { ok: false, reason: 'missing_webhook_secret' };
  }
  // Constant-time comparison to prevent timing attacks.
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(String(configSecret));
  if (a.length !== b.length) {
    return { ok: false, reason: 'invalid_webhook_secret' };
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0
    ? { ok: true, reason: 'ok' }
    : { ok: false, reason: 'invalid_webhook_secret' };
}

module.exports = { OmstudioClient, VERIFIED_PATHS, ASSUMED_PATHS, validateWebhookSecret };
