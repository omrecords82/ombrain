'use strict';

const { config } = require('../config');
const logger = require('../util/logger');
const { computeFleetHealthFromSummary } = require('../util/platformHealth');

class AuditorLoop {
  constructor(deps = {}) {
    this.db = deps.db || null;
    this.orchestrator = deps.orchestrator || null;
    this.tick = 0;
    this.timer = null;
  }

  async tickOnce() {
    this.tick += 1;
    logger.info('auditor_tick_start', { tick: this.tick });

    if (!this.db) {
      logger.warn('auditor_tick_no_db', { tick: this.tick });
      logger.info('auditor_tick_complete', { tick: this.tick, conditions_found: 0 });
      return { ok: true, conditions_found: 0 };
    }

    let conditions = 0;
    try {
      const events = this.db.recentEvents ? this.db.recentEvents(20) : [];
      const inventory = this.db.latestInventorySummary ? this.db.latestInventorySummary() : null;
      const health = computeFleetHealthFromSummary(inventory);
      if (health.severity === 'critical') conditions += 1;
      if (events.some((e) => /critical|failed|outage/i.test(JSON.stringify(e)))) conditions += 1;
    } catch (e) {
      logger.warn('auditor_tick_error', { tick: this.tick, name: e && e.name });
    }

    logger.info('auditor_tick_complete', { tick: this.tick, conditions_found: conditions });
    return { ok: true, conditions_found: conditions };
  }

  start() {
    if (!config.auditor.enabled) {
      this.timer = null;
      return;
    }
    if (this.timer) return;
    const interval = config.auditor.intervalMs || 300000;
    this.timer = setInterval(() => {
      this.tickOnce().catch((e) => logger.warn('auditor_tick_failed', { name: e && e.name }));
    }, interval);
    if (this.timer.unref) this.timer.unref();
    logger.info('auditor_started', { interval_ms: interval });
    this.tickOnce().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AuditorLoop };
