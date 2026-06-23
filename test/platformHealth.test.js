'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeFleetHealthFromSummary, diffHostStatuses } = require('../src/util/platformHealth');

test('computeFleetHealthFromSummary scales unreachable hosts', () => {
  const h = computeFleetHealthFromSummary({ unreachable: 2, services_failed: 0, degraded: 0, critical_alerts: 0 });
  assert.equal(h.score, 50);
});

test('computeFleetHealthFromSummary matches om-dev recovery scenario', () => {
  const before = computeFleetHealthFromSummary({ unreachable: 1, services_failed: 1, degraded: 0, critical_alerts: 0 });
  assert.equal(before.score, 60);
  const after = computeFleetHealthFromSummary({ unreachable: 0, services_failed: 0, degraded: 0, critical_alerts: 0 });
  assert.equal(after.score, 100);
});

test('diffHostStatuses detects recovery', () => {
  const prev = { 'om-dev': 'unreachable', auth0: 'online' };
  const servers = [
    { id: 'om-dev', hostname: 'om-dev.internal', status: 'online' },
    { id: 'auth0', hostname: 'auth0.internal', status: 'online' },
  ];
  const { recovered, degraded } = diffHostStatuses(prev, servers);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, 'om-dev');
  assert.equal(degraded.length, 0);
});
