'use strict';

const crypto = require('crypto');
const { getBuiltinOperation } = require('./registry');
const { runHandler } = require('./handlers');

/**
 * Execute a registered operation and persist an operation_runs row.
 *
 * @param {object} db - MemoryDB
 * @param {string} operationId
 * @param {object} [opts]
 * @param {string} [opts.description]
 * @param {boolean} [opts.commit]
 * @param {boolean} [opts.dry_run]
 * @param {string} [opts.triggered_by] - operator | api | schedule | ask
 * @returns {object} run record + handler result
 */
async function runOperation(db, operationId, opts = {}) {
  if (!db || typeof db.getOperation !== 'function') {
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

  const runId = crypto.randomUUID();
  const triggeredBy = opts.triggered_by || 'api';
  const params = {
    commit: !!opts.commit,
    dry_run: opts.dry_run != null ? !!opts.dry_run : !opts.commit,
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
    const handlerOpts = {
      commit: params.commit,
      dry_run: params.dry_run,
      description: opts.description,
      rootsPath: opts.rootsPath,
      structurePath: opts.structurePath,
      outPath: opts.outPath,
      run_id: runId,
    };
    const result = await Promise.resolve(runHandler(op.handler_ref, db, handlerOpts));
    const finishedAt = new Date().toISOString();
    const outputSummary = result.output_summary
      || (result.stats ? `total=${result.stats.total}` : 'completed');

    db.updateOperationRun(runId, {
      status: 'done',
      finished_at: finishedAt,
      exit_code: result.exit_code != null ? result.exit_code : 0,
      output_summary: outputSummary,
    });

    return {
      ok: true,
      run_id: runId,
      operation_id: operationId,
      status: 'done',
      triggered_by: triggeredBy,
      started_at: startedAt,
      finished_at: finishedAt,
      exit_code: result.exit_code != null ? result.exit_code : 0,
      output_summary: outputSummary,
      result,
    };
  } catch (e) {
    const finishedAt = new Date().toISOString();
    const exitCode = e.exitCode != null ? e.exitCode : 1;
    const outputSummary = (e.message || 'operation failed').slice(0, 2000);

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

module.exports = { runOperation };
