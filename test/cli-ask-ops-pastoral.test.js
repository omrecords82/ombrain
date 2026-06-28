'use strict';

/**
 * Integration tests for the rebuilt brain CLI subcommands: ask / pastoral / ops
 * (PR #282 fallout rebuild, 2026-06-28). Spawns the actual CLI binary.
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'om-brain-cli.js');

function run(args) {
  const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
  return out;
}

test('CLI ask — auto-classifies pastoral and includes clergy referral', () => {
  const out = run(['ask', 'how do I prepare for confession']);
  const obj = JSON.parse(out);
  assert.strictEqual(obj.mode, 'pastoral');
  assert.strictEqual(obj.type, 'pastoral.confession');
  assert.match(obj.answer, /priest|spiritual father/i);
});

test('CLI ask --mode override forces ops and gates actions behind governance', () => {
  const out = run(['ask', '--mode', 'ops', 'should I restart the service']);
  const obj = JSON.parse(out);
  assert.strictEqual(obj.mode, 'ops');
  assert.strictEqual(obj.type, 'ops.action_advisory');
  assert.strictEqual(obj.requiresGovernance, true);
});

test('CLI pastoral — direct subcommand returns grief guidance', () => {
  const out = run(['pastoral', 'I am grieving the loss of my father']);
  const obj = JSON.parse(out);
  assert.strictEqual(obj.mode, 'pastoral');
  assert.strictEqual(obj.type, 'pastoral.grief');
  assert.match(obj.answer, /priest|spiritual father/i);
});

test('CLI ops — direct subcommand returns read-only status', () => {
  const out = run(['ops', 'brain health status']);
  const obj = JSON.parse(out);
  assert.strictEqual(obj.mode, 'ops');
  assert.strictEqual(obj.type, 'ops.status');
  assert.ok('health' in obj);
});

test('CLI help — lists the new ask/pastoral/ops commands', () => {
  const out = run(['help']);
  assert.match(out, /ask <query/);
  assert.match(out, /pastoral <query/);
  assert.match(out, /ops <query/);
});
