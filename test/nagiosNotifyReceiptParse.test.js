'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReceiptArgv,
  parseReceiptBlock,
} = require('../src/ops/nagiosNotifyReceiptParse');

test('CUSTOM service notification fields parse correctly', () => {
  const parsed = parseReceiptArgv([
    'service',
    'CUSTOM',
    'localhost',
    'Swap Usage',
    'WARNING',
    'SWAP WARNING - 20% free',
    'ombrain',
    'OMBRAIN-OPALERT-20260805T020519Z',
    'ombrain-ops',
    '2026-08-05 02:05:19',
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.notification_type, 'CUSTOM');
  assert.equal(parsed.host, 'localhost');
  assert.equal(parsed.service, 'Swap Usage');
  assert.equal(parsed.state, 'WARNING');
  assert.equal(parsed.author, 'ombrain');
  assert.equal(parsed.comment, 'OMBRAIN-OPALERT-20260805T020519Z');
  assert.equal(parsed.test_marker, 'OMBRAIN-OPALERT-20260805T020519Z');
  assert.equal(parsed.command_source, 'service');
  assert.equal(parsed.contact, 'ombrain-ops');
  assert.equal(parsed.event_timestamp, '2026-08-05 02:05:19');
  assert.match(parsed.raw, /CUSTOM/);
});

test('host PROBLEM notification parses with optional fields omitted', () => {
  const parsed = parseReceiptArgv([
    'host',
    'PROBLEM',
    'operator',
    'DOWN',
    'CRITICAL - Host Unreachable (192.168.1.101)',
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host, 'operator');
  assert.equal(parsed.state, 'DOWN');
  assert.equal(parsed.service, null);
  assert.equal(parsed.author, null);
  assert.equal(parsed.test_marker, null);
});

test('malformed receipt records fail safely', () => {
  assert.equal(parseReceiptArgv([]).malformed, true);
  assert.equal(parseReceiptArgv(['service']).malformed, true);
  assert.equal(parseReceiptArgv(['nope', 'CUSTOM', 'h']).malformed, true);
  assert.equal(parseReceiptArgv(['service', 'CUSTOM']).malformed, true);
  assert.equal(parseReceiptArgv(['service', 'CUSTOM', '', 'svc', 'OK']).malformed, true);
  assert.equal(parseReceiptBlock('').malformed, true);
});

test('legacy empty structured block rescues fields from raw argv', () => {
  const block = [
    '----',
    'ts_utc=2026-08-05T02:05:20Z',
    'type=service',
    'host=',
    'service=',
    'hoststate=',
    'servicestate=',
    'output=',
    'contact=',
    'raw=service CUSTOM localhost Swap Usage WARNING SWAP WARNING - 20% free (190MB out of 975MB)',
  ].join('\n');
  const parsed = parseReceiptBlock(block);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.notification_type, 'CUSTOM');
  assert.equal(parsed.host, 'localhost');
  assert.equal(parsed.service, 'Swap');
  // Note: unquoted multi-word service name splits on whitespace in legacy raw;
  // new sink writes structured fields so this rescue is best-effort only.
  assert.equal(parsed.command_source, 'service');
  assert.equal(parsed.event_timestamp, '2026-08-05T02:05:20Z');
});
