'use strict';

const { config } = require('../config');
const logger = require('../util/logger');
const { QueryPipeline } = require('../queryPipeline/pipeline');

class CronManager {
  constructor(deps = {}) {
    this.pipeline = deps.pipeline || null;
    this.timer = null;
  }

  async runQueryPoll() {
    if (!this.pipeline) return;
    logger.info('cron_query_poll_tick');
    try {
      await this.pipeline.poll(10);
    } catch (e) {
      logger.warn('cron_query_poll_error', { name: e && e.name });
    }
  }

  start() {
    if (!config.queryPoll.enabled) {
      logger.info('cron_query_poll_disabled');
      return;
    }
    if (this.timer) return;
    const interval = config.queryPoll.intervalMs || 60000;
    this.timer = setInterval(() => {
      this.runQueryPoll().catch((e) => logger.warn('cron_query_poll_failed', { name: e && e.name }));
    }, interval);
    if (this.timer.unref) this.timer.unref();
    logger.info('cron_started', { query_poll_ms: interval });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { CronManager, QueryPipeline };
