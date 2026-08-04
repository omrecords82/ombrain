'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hostBucket,
  serviceBucket,
  hostIpFromName,
  HOST,
  SVC,
} = require('../src/adapters/nagiosAdapter');

test('hostIpFromName parses Nagios host objects', () => {
  assert.equal(hostIpFromName('host-192-168-1-254'), '192.168.1.254');
  assert.equal(hostIpFromName('localhost'), null);
});

test('hostBucket maps statusjson bitmasks', () => {
  assert.equal(hostBucket(HOST.UP), 'up');
  assert.equal(hostBucket(HOST.DOWN), 'down');
  assert.equal(hostBucket(HOST.UNREACHABLE), 'down');
  assert.equal(hostBucket(HOST.PENDING), 'pending');
});

test('serviceBucket maps statusjson bitmasks', () => {
  assert.equal(serviceBucket(SVC.OK), 'ok');
  assert.equal(serviceBucket(SVC.WARNING), 'warning');
  assert.equal(serviceBucket(SVC.CRITICAL), 'critical');
  assert.equal(serviceBucket(SVC.UNKNOWN), 'unknown');
});
