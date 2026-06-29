'use strict';

const crypto = require('crypto');
const { getBuiltinOperation } = require('./registry');
const { dispatchFleetOperation } = require('../fleet/dispatcher');

const FLEET_SPAWN_MODES = new Set(['fleet_ssh', 'fleet']);

function isFleetOperation(op) {
  if (!op) return false;
  if (FLEET_SPAWN_MODES.has(op.spawn_mode)) return true;
  return op.spawn_mode === 'fleet' || String(op.id || '').startsWith('fleet.');
}

/**
 * Execute a fleet operation: parent run + per-host child runs via SSH (or stub NATS).
 *
 * @param {object} db
 * @param {string} operationId
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function runFleetOperation(db, operationId, opts = {}) {
  if (!db || typeof db.createOperationRun !== 'function') {
    const err = new Error('database does not support operations');
    err.exitCode = 1;
    throw err;
  }

  const op = db.getOperation(operationId) || getBuiltinOperation(operationId);
  if (!op) {
    const err = new Error(`operation not found: ${operationId}`);
    err.exitCode = 1;
    err.code = 'operation_not_found';
    throw err;
  }
  if (!isFleetOperation(op)) {
    const err = new Error(`not a fleet operation: ${operationId}`);
    err.exitCode = 1;
    err.code = 'not_fleet_operation';
    throw err;
  }

  const runId = crypto.randomUUID();
  const triggeredBy = opts.triggered_by || 'api';
  const targets = opts.targets && opts.targets.length ? opts.targets : undefined;
  const transport = opts.transport || op.transport || 'ssh';
  const params = {
    targets: targets || opts.targets,
    transport,
    ...(opts.params || {}),
  };

  db.createOperationRun({
    id: runId,
    operation_id: operationId,
    description: opts.description || null,
    status: 'pending',
    triggered_by: triggeredBy,
    params_json: JSON.stringify(params),
  });

  const startedAt = new Date().toISOString();
  db.updateOperationRun(runId, { status: 'running', started_at: startedAt });

  try {
    const { report } = await dispatchFleetOperation({
      operationId,
      targets: targets || params.targets,
      parentRunId: runId,
      handlerRef: op.script_ref,
      transport,
      db,
      params,
      local: !!opts.local,
      transportImpl: opts.transportImpl,
    });

    const finishedAt = new Date().toISOString();
    const allOk = report.summary.hosts_ok === report.summary.hosts_requested;
    const outputSummary = `fleet ${report.summary.hosts_ok}/${report.summary.hosts_requested} hosts ok, ${report.summary.total_paths} paths`;

    db.updateOperationRun(runId, {
      status: allOk ? 'done' : 'failed',
      finished_at: finishedAt,
      exit_code: allOk ? 0 : 1,
      output_summary: outputSummary,
      params_json: JSON.stringify({ ...params, report }),
    });

    return {
      ok: allOk,
      run_id: runId,
      operation_id: operationId,
      status: allOk ? 'done' : 'failed',
      triggered_by: triggeredBy,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: allOk ? 0 : 1,
      output_summary: outputSummary,
      report,
    };
  } catch (e) {
    const finishedAt = new Date().toISOString();
    const exitCode = e.exitCode != null ? e.exitCode : 1;
    const outputSummary = (e.message || 'fleet operation failed').slice(0, 2000);

    db.updateOperationRun(runId, {
      status: 'failed',
      finished_at: finishedAt,
      exit_code: exitCode,
      output_summary: outputSummary,
    });

    return {
      ok: false,
      run_id: runId,
      operation_id: operationId,
      status: 'failed',
      triggered_by: triggeredBy,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: exitCode,
      output_summary: outputSummary,
      error: e.message,
    };
  }
}

module.exports = { runFleetOperation, isFleetOperation, FLEET_SPAWN_MODES };
