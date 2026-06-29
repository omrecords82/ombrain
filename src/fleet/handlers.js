'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_HANDLER_PREFIX = 'scripts/fleet/handlers/';

/** Operation ids satellites may execute — must match registry fleet ops. */
const ALLOWED_OPERATION_IDS = new Set([
  'fleet.find_env_files@v1',
]);

function assertAllowlistedOperation(operationId) {
  if (!ALLOWED_OPERATION_IDS.has(operationId)) {
    const err = new Error(`operation not allowlisted: ${operationId}`);
    err.code = 'operation_not_allowlisted';
    throw err;
  }
}

function assertAllowlistedHandler(handlerRef, root) {
  const rel = String(handlerRef || '').replace(/\\/g, '/');
  if (!rel.startsWith(ALLOWED_HANDLER_PREFIX) || rel.includes('..')) {
    const err = new Error(`handler not allowlisted: ${handlerRef}`);
    err.code = 'handler_not_allowlisted';
    throw err;
  }
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    const err = new Error(`handler script missing: ${rel}`);
    err.code = 'handler_missing';
    throw err;
  }
  return abs;
}

module.exports = {
  ALLOWED_HANDLER_PREFIX,
  ALLOWED_OPERATION_IDS,
  assertAllowlistedOperation,
  assertAllowlistedHandler,
};
