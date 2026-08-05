'use strict';

/**
 * Pure evaluator for the om-dev plans CIFS mount dependency.
 * Used by unit tests and can mirror omdev-resource-check.sh plans_mount.
 */

function evaluatePlansMount(input) {
  const expectSrc = input.expectSource || '//192.168.1.232/plans';
  const expectFs = input.expectFstype || 'cifs';
  const mount = input.mountPath || '/mnt/fileserver01/plans';

  if (!input.mounted) {
    return { state: 'critical', message: `plans mount missing at ${mount}` };
  }
  if (input.fstype !== expectFs) {
    return {
      state: 'critical',
      message: `plans fstype=${input.fstype} expected=${expectFs}`,
    };
  }
  if (input.source !== expectSrc) {
    return {
      state: 'critical',
      message: `plans source=${input.source} expected=${expectSrc}`,
    };
  }
  if (input.responsive === false || input.readable === false) {
    return { state: 'critical', message: 'plans mount unresponsive or unreadable' };
  }
  if (input.directoryExists === false) {
    return { state: 'critical', message: 'plans directory missing' };
  }
  const pct = Number(input.usedPct);
  if (!Number.isFinite(pct)) {
    return { state: 'unknown', message: 'cannot measure plans free space' };
  }
  if (pct >= 95) {
    return { state: 'critical', message: `plans ${pct}% used`, usedPct: pct };
  }
  if (pct >= 85) {
    return { state: 'warning', message: `plans ${pct}% used`, usedPct: pct };
  }
  return {
    state: 'ok',
    message: `plans mounted src=${input.source} fstype=${input.fstype} ${pct}% used`,
    usedPct: pct,
  };
}

module.exports = { evaluatePlansMount };
