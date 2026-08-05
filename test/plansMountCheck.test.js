'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePlansMount } = require('../src/health/plansMountCheck');
const {
  ALLOWED_OMDEV_RESOURCE_CHECKS,
  isAllowlistedResourceCheck,
} = require('../src/health/omdevResourceChecks');

test('CIFS mount healthy state', () => {
  const r = evaluatePlansMount({
    mounted: true,
    fstype: 'cifs',
    source: '//192.168.1.232/plans',
    responsive: true,
    readable: true,
    directoryExists: true,
    usedPct: 4,
  });
  assert.equal(r.state, 'ok');
});

test('Missing CIFS mount state', () => {
  const r = evaluatePlansMount({ mounted: false });
  assert.equal(r.state, 'critical');
  assert.match(r.message, /missing/);
});

test('Stale or unresponsive mount state', () => {
  const r = evaluatePlansMount({
    mounted: true,
    fstype: 'cifs',
    source: '//192.168.1.232/plans',
    responsive: false,
    readable: true,
    directoryExists: true,
    usedPct: 4,
  });
  assert.equal(r.state, 'critical');
  assert.match(r.message, /unresponsive/);
});

test('Incorrect remote source state', () => {
  const r = evaluatePlansMount({
    mounted: true,
    fstype: 'cifs',
    source: '//192.168.1.79/OM-backups',
    responsive: true,
    readable: true,
    directoryExists: true,
    usedPct: 4,
  });
  assert.equal(r.state, 'critical');
  assert.match(r.message, /expected/);
});

test('resource checks accept only allowlisted commands', () => {
  assert.equal(isAllowlistedResourceCheck('root_disk'), true);
  assert.equal(isAllowlistedResourceCheck('plans_mount'), true);
  assert.equal(isAllowlistedResourceCheck('rm -rf /'), false);
  assert.equal(isAllowlistedResourceCheck('arbitrary'), false);
  assert.ok(ALLOWED_OMDEV_RESOURCE_CHECKS.length >= 10);
});
