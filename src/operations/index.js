'use strict';

const { getBuiltinOperations, getBuiltinOperation, BUILTIN_OPERATIONS } = require('./registry');
const { runOperation } = require('./runner');
const { matchOperationIntent } = require('./intent');

module.exports = {
  BUILTIN_OPERATIONS,
  getBuiltinOperations,
  getBuiltinOperation,
  runOperation,
  matchOperationIntent,
};
