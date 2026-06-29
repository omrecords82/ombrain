'use strict';

const crypto = require('crypto');
const logger = require('../util/logger');
const { resolveHost } = require('./hosts');
const sshTransport = require('./transports/ssh');
const natsTransport = require('./transports/nats');
const { redactFleetResult } = require('./redact');
const { resolveFleetTransport } = require('./natsClient');

const DEFAULT_TARGETS = ['om-prod01'];

const TRANSPORTS = {
  ssh: sshTransport,
  nats: natsTransport,
};

function getTransport(name) {
  const t = TRANSPORTS[name];
  if (!t) {
    const err = new Error(`unknown fleet transport: ${name}`);
    err.code = 'unknown_transport';
    throw err;
  }
  return t;
}

function parseHandlerJson(stdout, hostConfig) {
  if (!stdout) {
    return {
      hostname: hostConfig.name,
      paths: [],
      count: 0,
      errors: ['empty stdout from handler'],
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return redactFleetResult(parsed);
  } catch (e) {
    return {
      hostname: hostConfig.name,
      paths: [],
      count: 0,
      errors: [`invalid JSON from handler: ${(e.message || 'parse error').slice(0, 200)}`],
    };
  }
}

/**
 * Dispatch a fleet operation to one or more inventory hosts.
 *
 * @param {object} opts
 * @param {string} opts.operationId
 * @param {string[]} [opts.targets]
 * @param {string} opts.parentRunId
 * @param {string} opts.handlerRef - allowlisted script path
 * @param {string} [opts.transport] - ssh | nats
 * @param {object} [opts.db] - MemoryDB for child run persistence
 * @param {object} [opts.params]
 * @param {boolean} [opts.local] - run handler locally (tests)
 * @param {object} [opts.transportImpl] - inject transport for tests
 * @returns {Promise<{ children: object[], report: object }>}
 */
async function dispatchFleetOperation(opts = {}) {
  const {
    operationId,
    targets = DEFAULT_TARGETS,
    parentRunId,
    handlerRef,
    transport: transportOpt,
    db,
    params = {},
    local = false,
    transportImpl,
  } = opts;

  if (!operationId || !parentRunId || !handlerRef) {
    throw new Error('operationId, parentRunId, and handlerRef are required');
  }

  const transport = resolveFleetTransport(transportOpt);
  const transportModule = transportImpl || getTransport(transport);
  const executeFn = local
    ? sshTransport.executeLocal
    : transportModule.execute;

  const hostTargets = (targets.length ? targets : DEFAULT_TARGETS).slice();
  const children = [];

  for (const target of hostTargets) {
    const hostConfig = resolveHost(target);
    if (!hostConfig) {
      const childId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const finishedAt = startedAt;
      const result = {
        hostname: target,
        paths: [],
        count: 0,
        errors: [`host not found in inventory: ${target}`],
      };
      const child = {
        id: childId,
        parent_run_id: parentRunId,
        host: target,
        hostname: target,
        status: 'failed',
        exit_code: 1,
        result_json: JSON.stringify(result),
        transport,
        started_at: startedAt,
        finished_at: finishedAt,
      };
      if (db && typeof db.createOperationRunChild === 'function') {
        db.createOperationRunChild(child);
        db.updateOperationRunChild(childId, {
          status: 'failed',
          finished_at: finishedAt,
          exit_code: 1,
          result_json: child.result_json,
        });
      }
      children.push({ ...child, result });
      logger.warn('fleet_host_unknown', { target, parent_run_id: parentRunId });
      continue;
    }

    const childId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    if (db && typeof db.createOperationRunChild === 'function') {
      db.createOperationRunChild({
        id: childId,
        parent_run_id: parentRunId,
        host: hostConfig.name,
        hostname: hostConfig.name,
        status: 'running',
        transport,
        started_at: startedAt,
      });
    }

    logger.info('fleet_dispatch_host', {
      operation_id: operationId,
      parent_run_id: parentRunId,
      host: hostConfig.name,
      ip: hostConfig.ip,
      transport,
      local: !!local,
    });

    let execOut;
    try {
      const maybePromise = executeFn(hostConfig, handlerRef, params.env || {}, {
        runId: childId,
        parentRunId,
        operationId,
        params,
      });
      execOut = maybePromise && typeof maybePromise.then === 'function'
        ? await maybePromise
        : maybePromise;
    } catch (e) {
      execOut = {
        stdout: '',
        stderr: e.message || 'transport error',
        exit_code: 1,
      };
    }

    const finishedAt = new Date().toISOString();
    const parsed = parseHandlerJson(execOut.stdout, hostConfig);
    if (execOut.stderr) {
      parsed.errors = [...(parsed.errors || []), execOut.stderr.slice(0, 500)];
    }
    const redacted = redactFleetResult(parsed);
    const exitCode = execOut.exit_code != null ? execOut.exit_code : 1;
    const status = exitCode === 0 && (!redacted.errors || redacted.errors.length === 0)
      ? 'done'
      : (exitCode === 0 ? 'done' : 'failed');

    const childRecord = {
      id: childId,
      parent_run_id: parentRunId,
      host: hostConfig.name,
      hostname: redacted.hostname || hostConfig.name,
      status,
      exit_code: exitCode,
      result_json: JSON.stringify(redacted),
      transport,
      started_at: startedAt,
      finished_at: finishedAt,
    };

    if (db && typeof db.updateOperationRunChild === 'function') {
      db.updateOperationRunChild(childId, {
        hostname: childRecord.hostname,
        status,
        exit_code: exitCode,
        result_json: childRecord.result_json,
        finished_at: finishedAt,
      });
    }

    children.push({ ...childRecord, result: redacted });
  }

  const report = buildAggregationReport(operationId, parentRunId, children);
  return { children, report };
}

function buildAggregationReport(operationId, parentRunId, children) {
  const hosts = children.map((c) => {
    const r = c.result || (c.result_json ? JSON.parse(c.result_json) : {});
    return {
      hostname: c.hostname || c.host,
      paths: r.paths || [],
      count: r.count != null ? r.count : (r.paths || []).length,
      errors: r.errors || [],
      exit_code: c.exit_code != null ? c.exit_code : 1,
      started_at: c.started_at,
      finished_at: c.finished_at,
    };
  });

  return {
    operation_id: operationId,
    parent_run_id: parentRunId,
    summary: {
      hosts_requested: children.length,
      hosts_ok: children.filter((c) => c.exit_code === 0).length,
      total_paths: hosts.reduce((sum, h) => sum + (h.count || 0), 0),
    },
    hosts,
  };
}

module.exports = {
  DEFAULT_TARGETS,
  TRANSPORTS,
  getTransport,
  dispatchFleetOperation,
  buildAggregationReport,
  parseHandlerJson,
};
