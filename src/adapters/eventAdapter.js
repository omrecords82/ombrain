'use strict';

/**
 * Event ingestion adapter (READ-ONLY) — Spec v1.1 §4.
 *
 * Polls the OMAI ops plane (/api/platform/events and /api/deploy-runs) on the
 * :7060 plane via the public edge. Authenticates with a JWT bearer from env.
 * On unauthorized/unreachable it logs a REDACTED error and continues — no crash
 * loop. Every ingested payload is REDACTED before persistence.
 */

const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const adapterStatus = require('../health/adapterStatus');
const { resolveTargetIdentity } = require('../ingest/eventIdentity');
const logger = require('../util/logger');

class EventAdapter {
  /**
   * @param {object} deps { db, fetchImpl }
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.fetch = deps.fetchImpl || globalThis.fetch;
    this.timer = null;
    this.cfg = config.ingest;
  }

  _url(pathname, params = {}) {
    const u = new URL(pathname, this.cfg.apiBaseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  }

  _headers() {
    const h = { Accept: 'application/json' };
    if (this.cfg.jwt) h.Authorization = `Bearer ${this.cfg.jwt}`;
    return h;
  }

  async pollOnce() {
    await this._safeGet('events', this._url(this.cfg.eventsPath, { hours: 24, limit: 50 }));
    await this._safeGet('deploy_runs', this._url(this.cfg.deployRunsPath, { limit: 10 }));
  }

  async _safeGet(source, url) {
    try {
      if (!this.fetch) {
        logger.warn('event_adapter_no_fetch', { source });
        return;
      }
      const res = await this.fetch(url, { headers: this._headers() });
      if (!res.ok) {
        adapterStatus.recordPoll(source, { ok: false, status: res.status });
        // 401/403/404/5xx — redacted error, continue (no crash loop).
        logger.warn('event_adapter_non_ok', { source, status: res.status });
        return;
      }
      const data = await res.json();
      const items = Array.isArray(data) ? data : data.events || data.runs || [];
      for (const raw of items) {
        const safe = redactForLog(raw);
        const eventType = safe.event_type || safe.status || null;
        // Resolve target identity (registry-enriched) before persistence so
        // host reachability events always carry target_name/target_ip.
        const identity = resolveTargetIdentity(eventType, safe);
        if (identity.registry_resolution) {
          safe.registry_resolution = identity.registry_resolution;
        }
        this.db &&
          this.db.insertEvent({
            source,
            event_type: eventType,
            severity: safe.severity || null,
            church_id: null, // tenant ids are redacted upstream; never persist raw
            correlation: safe.request_id || safe.id || null,
            payload_json: JSON.stringify(safe),
            target_name: identity.target_name,
            target_ip: identity.target_ip,
            target_host: identity.target_host,
            target_service: identity.target_service,
            check_method: identity.check_method,
            checked_from: identity.checked_from,
            target_identity_status: identity.target_identity_status,
          });
      }
      adapterStatus.recordPoll(source, { ok: true, status: res.status });
      logger.info('event_adapter_ingested', { source, count: items.length });
    } catch (e) {
      adapterStatus.recordPoll(source, { ok: false, error: e && e.name });
      // Network/parse errors are swallowed (redacted) — keep running.
      logger.warn('event_adapter_error', { source, name: e && e.name });
    }
  }

  start() {
    adapterStatus.setEnabled('events', this.cfg.enableEventAdapter);
    adapterStatus.setEnabled('deploy_runs', this.cfg.enableEventAdapter);
    if (!this.cfg.enableEventAdapter) {
      logger.info('event_adapter_disabled');
      return;
    }
    const tick = () => this.pollOnce().catch(() => {});
    tick();
    this.timer = setInterval(tick, this.cfg.eventsPollMs);
    if (this.timer.unref) this.timer.unref();
    logger.info('event_adapter_started', { interval_ms: this.cfg.eventsPollMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { EventAdapter };
