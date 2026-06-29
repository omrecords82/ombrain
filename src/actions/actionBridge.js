'use strict';

/**
 * Action bridge — enforces commit/dry-run/confirmation rules before OMAI execution.
 */

const client = require('./omaiActionClient');

async function listActions(filters) {
  return client.listActions(filters);
}

async function showAction(actionId) {
  return client.getAction(actionId);
}

async function resolveQuery(query) {
  return client.resolveAction(query);
}

async function runAction(actionId, opts = {}) {
  const show = await client.getAction(actionId).catch(() => null);
  const action = show && show.action;
  const explicitDryRun = opts.dry_run === true;
  const explicitCommit = !!opts.commit;
  const confirmed = !!opts.confirmed;

  if (action && action.mutation && !explicitCommit && !explicitDryRun) {
    const err = new Error('Write actions require --commit');
    err.statusCode = 400;
    err.code = 'commit_required';
    throw err;
  }

  if (action && action.risk === 'high' && explicitCommit && !confirmed) {
    const err = new Error('High-risk actions require --confirm');
    err.statusCode = 428;
    err.code = 'confirmation_required';
    throw err;
  }

  let dry_run;
  let commit;
  if (explicitDryRun) {
    dry_run = true;
    commit = false;
  } else if (explicitCommit) {
    dry_run = false;
    commit = true;
  } else if (action && !action.mutation) {
    // Read-only actions execute without --commit.
    dry_run = false;
    commit = true;
  } else if (action && action.supports_dry_run) {
    dry_run = true;
    commit = false;
  } else {
    dry_run = false;
    commit = false;
  }

  return client.runAction(actionId, {
    input: opts.input,
    dry_run,
    commit,
    confirmed,
  });
}

async function history(limit) {
  return client.listHistory(limit);
}

module.exports = {
  listActions,
  showAction,
  resolveQuery,
  runAction,
  history,
  isConfigured: client.isConfigured,
};
