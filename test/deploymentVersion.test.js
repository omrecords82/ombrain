'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDeploymentVersionReport } = require('../src/health/deploymentVersion');

test('deployment-version reporting identifies component drift accurately', () => {
  const origin = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const older = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const drifted = buildDeploymentVersionReport({
    env: { BRAIN_ORIGIN_MAIN_COMMIT: origin },
    componentCommits: {
      om_brain_backend: older,
      om_brain_console: older,
      omai_frontend: older,
    },
  });
  assert.equal(drifted.drift_status, 'drift');
  assert.equal(drifted.components.om_brain_backend.in_sync_with_origin_main, false);

  const synced = buildDeploymentVersionReport({
    env: { BRAIN_ORIGIN_MAIN_COMMIT: origin },
    componentCommits: {
      om_brain_backend: origin,
      om_brain_console: origin,
      omai_frontend: origin,
    },
  });
  assert.equal(synced.drift_status, 'in_sync');
  assert.equal(synced.components.om_brain_backend.in_sync_with_origin_main, true);

  const unknown = buildDeploymentVersionReport({
    env: { BRAIN_ORIGIN_MAIN_COMMIT: origin },
    componentCommits: {
      om_brain_backend: null,
      om_brain_console: null,
      omai_frontend: null,
    },
  });
  assert.equal(unknown.drift_status, 'unknown');
});
