'use strict';

/**
 * Minimal runtime hooks for the read-only WorkshopClient (.251).
 * Used at startup probe and by workshop.status@v1 operation.
 */

const crypto = require('crypto');
const { WorkshopClient } = require('./workshopClient');
const logger = require('../util/logger');

/**
 * Build a WorkshopClient from central config.
 * @param {object} cfg - config.workshop + config.isProduction
 */
function createWorkshopClient(cfg) {
  return new WorkshopClient({
    baseUrl: cfg.baseUrl,
    serviceToken: cfg.serviceToken,
    transport: cfg.transport,
    production: cfg.production,
  });
}

/**
 * Summarize a getStatus() result for logs and operation output.
 */
function summarizeWorkshopStatus(result) {
  if (!result) return 'no result';
  if (result.blocked) return `blocked:${result.reason || 'circuit_breaker'}`;
  if (!result.ok) return `http_fail:status=${result.status || 0}`;
  const d = result.data;
  if (d && typeof d === 'object') {
    if (d.service) return `${d.service} up=${d.up != null ? d.up : '?'}`;
    if (d.note) return String(d.note).slice(0, 120);
    return `status=${result.status} keys=${Object.keys(d).slice(0, 4).join(',')}`;
  }
  return `status=${result.status || 0} transport=${result.transport}`;
}

/**
 * Probe Workshop status; logs run_id, target host, and result summary.
 * @returns {Promise<object>}
 */
async function probeWorkshopStatus(client, opts = {}) {
  const runId = opts.run_id || crypto.randomUUID();
  let target = '';
  try {
    target = new URL(client.baseUrl).host;
  } catch (_) {
    target = client.baseUrl || 'unknown';
  }

  logger.info('workshop_probe_start', {
    run_id: runId,
    target,
    transport: client.transport,
  });

  const status = await client.getStatus();
  const summary = summarizeWorkshopStatus(status);

  logger.info('workshop_probe_done', {
    run_id: runId,
    target,
    transport: status.transport,
    ok: status.ok,
    summary,
  });

  return {
    run_id: runId,
    target,
    ok: status.ok,
    transport: status.transport,
    summary,
    status,
  };
}

module.exports = {
  createWorkshopClient,
  probeWorkshopStatus,
  summarizeWorkshopStatus,
};
