'use strict';

/**
 * OM Workshop read-only client (.251) — Phase 2 satellite read hook.
 *
 * Surfaces OM Workshop launcher/registry/build state to om-brain as READ-ONLY
 * data. The Brain never mutates Workshop through this client; it only GETs
 * status and registry snapshots for diagnostics and intent answers.
 *
 * Routing truth (docs/om-brain/02-brain-architecture-server-map.md §4):
 *   - om-workshop systemd on 192.168.1.251, manifest API port 7071 (OMWORKSHOP_PORT)
 *   - Also reachable via the .239 edge proxy: /workshop-embed/__server/*
 *   - The Brain prefers the direct LAN base (http://192.168.1.251:7071) but the
 *     base URL is configurable via OMWORKSHOP_BASE_URL.
 *
 * Doctrine guarantees (same as omstudioClient):
 *   - LAN/allowed-host ONLY: circuit breaker refuses external hosts.
 *   - REDACT BEFORE EGRESS / on log: responses pass through redactForLog.
 *   - Read-only: only GET requests; no POST/PUT/DELETE surface is exposed.
 *   - Optional Bearer service token, header-only, never logged.
 *
 * Adapter interface (stable; transports swappable):
 *   - checkEndpoint()        -> { allowed, reason, host }
 *   - getStatus()            -> { ok, transport, status, data }
 *   - getRegistry()          -> { ok, transport, status, data }
 *   - getBuildState()        -> { ok, transport, status, data }
 *   - checkHealth()          -> { ok, transport, status }
 */

const breaker = require('../ai/circuitBreaker');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

// Read-only Workshop REST paths (manifest/server-map derived).
const PATHS = Object.freeze({
  health:   '/__server/health',
  status:   '/__server/status',
  registry: '/__server/registry',
  build:    '/__server/build-state',
});

class WorkshopClient {
  /**
   * @param {object} opts
   * @param {string}  opts.baseUrl       Workshop base URL (default direct LAN .251:7071)
   * @param {string}  [opts.serviceToken] optional Bearer token (never logged)
   * @param {('dryrun'|'http')} [opts.transport]
   * @param {boolean} [opts.production]
   * @param {Function} [opts.httpImpl]   injectable fetch for tests
   * @param {object}   [opts.fixtures]   dryrun canned responses by kind
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || 'http://192.168.1.251:7071';
    this.serviceToken = opts.serviceToken || '';
    this.transport = opts.transport === 'http' ? 'http' : 'dryrun';
    this.production = !!opts.production;
    this.http = opts.httpImpl || globalThis.fetch;
    this.fixtures = opts.fixtures || {};
    this.paths = PATHS;
  }

  /** Circuit-breaker check for the configured Workshop base URL. */
  checkEndpoint() {
    if (this.transport === 'dryrun' && !this.baseUrl) {
      return { allowed: true, reason: 'dryrun_no_base_url', host: '' };
    }
    return breaker.checkHost(this.baseUrl, { production: this.production });
  }

  _url(pathname) {
    return new URL(pathname, this.baseUrl).toString();
  }

  /**
   * Read-only GET with circuit-breaker enforcement. Never sends a body.
   * @returns {Promise<{status:number, ok:boolean, json:any}>}
   */
  async _httpGet(url) {
    const verdict = this.checkEndpoint();
    if (!verdict.allowed) {
      const err = new Error('workshop_endpoint_blocked:' + verdict.reason);
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
    const res = await this.http(url, { method: 'GET', headers });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
    return { status: res.status, ok: res.ok, json };
  }

  /** Shared read implementation for status/registry/build. */
  async _read(kind, pathname) {
    if (this.transport === 'dryrun') {
      const data = this.fixtures[kind] !== undefined
        ? this.fixtures[kind]
        : { note: `dryrun: no live workshop ${kind}` };
      return { ok: true, transport: 'dryrun', status: 0, data: redactForLog(data) };
    }
    try {
      const r = await this._httpGet(this._url(pathname));
      logger.info('workshop_read_http', { kind, status: r.status, ok: r.ok });
      return { ok: r.ok, transport: 'http', status: r.status, data: redactForLog(r.json) };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        logger.warn('workshop_read_blocked', { kind, reason: e.verdict && e.verdict.reason });
        return { ok: false, transport: 'http', blocked: true, reason: e.verdict.reason, data: null };
      }
      logger.warn('workshop_read_error', { kind, name: e && e.name });
      return { ok: false, transport: 'http', reason: 'transport_error', data: null };
    }
  }

  getStatus()     { return this._read('status', this.paths.status); }
  getRegistry()   { return this._read('registry', this.paths.registry); }
  getBuildState() { return this._read('build', this.paths.build); }

  async checkHealth() {
    if (this.transport === 'dryrun') return { ok: true, transport: 'dryrun' };
    try {
      const r = await this._httpGet(this._url(this.paths.health));
      return { ok: r.ok, transport: 'http', status: r.status };
    } catch (e) {
      if (e.code === 'CIRCUIT_BREAKER') {
        return { ok: false, transport: 'http', blocked: true, reason: e.verdict.reason };
      }
      return { ok: false, transport: 'http', reason: 'transport_error' };
    }
  }
}

module.exports = { WorkshopClient, WORKSHOP_PATHS: PATHS };
