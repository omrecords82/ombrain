'use strict';

/**
 * Inventory ingestion adapter (READ-ONLY) — Spec v1.1 §4.
 *
 * Periodically GETs GET /api/platform/inventory?fresh=1 to maintain host
 * posture. JWT bearer auth from env. Redacted error + continue on failure.
 */

const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

class InventoryAdapter {
  constructor(deps = {}) {
    this.db = deps.db;
    this.fetch = deps.fetchImpl || globalThis.fetch;
    this.timer = null;
    this.cfg = config.ingest;
    this.latest = null;
  }

  _url() {
    const u = new URL(this.cfg.inventoryPath, this.cfg.apiBaseUrl);
    if (this.cfg.inventoryFresh) u.searchParams.set('fresh', String(this.cfg.inventoryFresh));
    return u.toString();
  }

  _headers() {
    const h = { Accept: 'application/json' };
    if (this.cfg.jwt) h.Authorization = `Bearer ${this.cfg.jwt}`;
    return h;
  }

  async pollOnce() {
    try {
      if (!this.fetch) {
        logger.warn('inventory_adapter_no_fetch');
        return;
      }
      const res = await this.fetch(this._url(), { headers: this._headers() });
      if (!res.ok) {
        logger.warn('inventory_adapter_non_ok', { status: res.status });
        return;
      }
      const data = await res.json();
      const safe = redactForLog(data);
      this.latest = safe;
      this.db &&
        this.db.insertEvent({
          source: 'inventory',
          event_type: 'inventory_snapshot',
          severity: null,
          church_id: null,
          correlation: null,
          payload_json: JSON.stringify(safe),
        });
      logger.info('inventory_adapter_ingested');
    } catch (e) {
      logger.warn('inventory_adapter_error', { name: e && e.name });
    }
  }

  start() {
    if (!this.cfg.enableInventoryAdapter) {
      logger.info('inventory_adapter_disabled');
      return;
    }
    const tick = () => this.pollOnce().catch(() => {});
    tick();
    this.timer = setInterval(tick, this.cfg.inventoryPollMs);
    if (this.timer.unref) this.timer.unref();
    logger.info('inventory_adapter_started', { interval_ms: this.cfg.inventoryPollMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { InventoryAdapter };
