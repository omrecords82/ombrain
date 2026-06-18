'use strict';

/**
 * Inventory ingestion adapter (READ-ONLY) — Spec v1.1 §4.
 *
 * Periodically GETs GET /api/platform/inventory?fresh=1 to maintain host
 * posture. Detects fleet health transitions and emits OMStudio observability
 * audits when posture improves or hosts recover.
 */

const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const { computeFleetHealthFromSummary, diffHostStatuses } = require('../util/platformHealth');
const logger = require('../util/logger');

class InventoryAdapter {
  constructor(deps = {}) {
    this.db = deps.db;
    this.governance = deps.governance || null;
    this.fetch = deps.fetchImpl || globalThis.fetch;
    this.timer = null;
    this.cfg = config.ingest;
    this.latest = null;
    this.prevHealth = null;
    this.prevHostMap = null;
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

  async _handleTransitions(data) {
    if (!this.governance) return;

    const health = computeFleetHealthFromSummary(data.summary);
    const hostDiff = diffHostStatuses(this.prevHostMap, data.servers);

    if (this.prevHealth?.score != null && health.score != null && health.score > this.prevHealth.score) {
      await this.governance.emitObservabilityAudit({
        kind: 'platform_health_improved',
        title: 'Platform health improved',
        message: `Fleet health rose from ${this.prevHealth.score}% to ${health.score}% (${health.detail}).`,
        payload: {
          from_score: this.prevHealth.score,
          to_score: health.score,
          from_severity: this.prevHealth.severity,
          to_severity: health.severity,
          detail: health.detail,
        },
      });
    }

    for (const host of hostDiff.recovered) {
      await this.governance.emitObservabilityAudit({
        kind: 'host_recovered',
        title: `Host recovered: ${host.hostname || host.id}`,
        message: `${host.id} transitioned from ${host.from} to ${host.to}.`,
        payload: host,
      });
    }

    this.prevHealth = health;
    this.prevHostMap = Object.fromEntries((data.servers || []).map((s) => [s.id, s.status]));
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

      await this._handleTransitions(data);

      this.db &&
        this.db.insertEvent({
          source: 'inventory',
          event_type: 'inventory_snapshot',
          severity: null,
          church_id: null,
          correlation: null,
          payload_json: JSON.stringify(safe),
        });
      logger.info('inventory_adapter_ingested', {
        health_score: computeFleetHealthFromSummary(data.summary).score,
      });
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
