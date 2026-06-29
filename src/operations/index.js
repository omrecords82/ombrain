'use strict';

const { getBuiltinOperations, getBuiltinOperation, BUILTIN_OPERATIONS } = require('./registry');
const { runOperation } = require('./runner');
const { runFleetOperation, isFleetOperation } = require('./fleetRunner');
const { matchOperationIntent } = require('./intent');

module.exports = {
  BUILTIN_OPERATIONS,
  getBuiltinOperations,
  getBuiltinOperation,
  runOperation,
  runFleetOperation,
  isFleetOperation,
  matchOperationIntent,
};
