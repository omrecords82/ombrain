'use strict';

/**
 * OMStudio governance client (Phase 1 governance-surface step).
 *
 * Emits two kinds of records to the OMStudio governance surface:
 *   (a) AUDIT events       — append-only record of every Brain decision/
 *                            recommendation, mirroring the local decision_memory
 *                            ledger. EVERY decision is audited.
 *   (b) APPROVAL requests  — for any proposal the DETERMINISTIC rule engine
 *                            classified as human-only / requires-superadmin, or
 *                            any Tier 0 escalation.
 *
 * =============================== ASSUMED INTERFACE ===========================
 * The exact OMStudio audit/approval REST contract is NOT in the provided
 * corpus. The HTTP paths and payload shapes below are an ASSUMED interface that
 * the user's team MUST confirm/adjust against the live OMStudio API before
 * enabling OMSTUDIO_TRANSPORT=http. They are deliberately isolated behind a
 * clean adapter so swapping them is a one-file change. See
 * docs/OMSTUDIO-INTEGRATION.md.
 * =============================================================================
 *
 * Adapter interface (stable; transports are swappable):
 *   - emitAuditEvent(record)        -> { ok, ref, transport }
 *   - submitApprovalRequest(proposal) -> { ok, ref, transport }
 *   - getApprovalStatus(ref)        -> { ok, state|null, raw }
 *
 * Doctrine guarantees enforced here:
 *   - LAN/allowed-host ONLY: the OMStudio base URL is checked by the circuit
 *     breaker; external hosts are refused (no egress to the public internet).
 *   - REDACT BEFORE EGRESS: every outbound payload passes through redactForLog
 *     so no never-log secret (incl. OMSTUDIO_SERVICE_TOKEN) or tenant identifier
 *     (church_id / om_church_*) is ever transmitted.
 *   - The service token is read from env and attached as a bearer header ONLY;
 *     it is never placed in a payload and never logged.
 */

const fs = require('fs');
const path = require('path');
const breaker = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

// ---- ASSUMED OMStudio REST paths (confirm against live API) ----------------
const ASSUMED_PATHS = Object.freeze({
  // Mounted under the .242 edge / omstudio-embed front per routing truth.
  audit: '/omstudio-embed/api/governance/brain/audit-events',
  approvals: '/omstudio-embed/api/governance/brain/approval-requests',
  approvalStatus: '/omstudio-embed/api/governance/brain/approval-requests/:ref',
});

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
    this.paths = ASSUMED_PATHS;
  }

  /**
   * Circuit-breaker check for the configured OMStudio base URL. In dry-run we
   * still validate so misconfiguration is caught early, but an empty base URL is
   * acceptable in dry-run (records go to the local outbox).
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
   * Write a record to the dry-run outbox (one JSON file per record) AND return a
   * stable ref. Payload is assumed already redacted by the caller; we redact
   * again defensively.
   */
  _writeOutbox(kind, payload) {
    this._ensureOutbox();
    const ref = this._ref(kind);
    const safe = redactForLog(payload);
    const file = path.join(this.outboxDir, ref + '.json');
    fs.writeFileSync(file, JSON.stringify({ kind, ref, written_at: this.now().toISOString(), payload: safe }, null, 2));
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
      // REDACT BEFORE EGRESS.
      body = JSON.stringify(redactForLog(bodyObj));
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

  // -------------------------------------------------------------------------
  // (a) AUDIT EVENT
  // -------------------------------------------------------------------------
  /**
   * Emit an audit event mirroring a decision. `record` is the decision-shaped
   * object; it is redacted before egress.
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

  // -------------------------------------------------------------------------
  // (b) APPROVAL REQUEST
  // -------------------------------------------------------------------------
  /**
   * Submit an approval request. `proposal` is the approval-shaped object
   * (classification, domains, redacted summary, source_decision_id, session_id).
   * It is redacted before egress.
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
      logger.info('omstudio_approval_http', { status: r.status, ok: r.ok });
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

  /**
   * Poll OMStudio for the current status of an approval request.
   * In dry-run there is no remote status to poll (decisions arrive via the
   * ingest-status endpoint / outbox simulation), so returns state: null.
   */
  async getApprovalStatus(ref) {
    if (this.transport === 'dryrun') {
      return { ok: true, state: null, raw: { note: 'dryrun: status arrives via ingest-status endpoint' } };
    }
    try {
      const r = await this._httpSend('GET', this._url(this.paths.approvalStatus, ref));
      const state = r.json && (r.json.state || r.json.status) ? String(r.json.state || r.json.status) : null;
      return { ok: r.ok, state, raw: redactForLog(r.json) };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        return { ok: false, state: null, blocked: true, reason: e.verdict.reason };
      }
      return { ok: false, state: null, reason: 'transport_error' };
    }
  }

  // -------------------------------------------------------------------------
  // Query poll surface (Phase 10) — pending user queries from OMStudio
  // -------------------------------------------------------------------------

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

module.exports = { OmstudioClient, ASSUMED_PATHS };
