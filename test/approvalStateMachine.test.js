'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const sm = require('../src/governance/approvalStateMachine');

test('valid forward transitions are allowed', () => {
  assert.equal(sm.canTransition('PENDING_SUBMISSION', 'SUBMITTED', sm.SOURCES.BRAIN_SUBMIT).ok, true);
  assert.equal(sm.canTransition('PENDING_SUBMISSION', 'WITHDRAWN', sm.SOURCES.OMSTUDIO_INGEST).ok, true);
  assert.equal(sm.canTransition('SUBMITTED', 'APPROVED', sm.SOURCES.OMSTUDIO_INGEST).ok, true);
  assert.equal(sm.canTransition('SUBMITTED', 'REJECTED', sm.SOURCES.OMSTUDIO_INGEST).ok, true);
  assert.equal(sm.canTransition('SUBMITTED', 'EXPIRED', sm.SOURCES.OMSTUDIO_INGEST).ok, true);
});

test('invalid transitions are rejected', () => {
  // cannot skip submission
  assert.equal(sm.canTransition('PENDING_SUBMISSION', 'APPROVED', sm.SOURCES.OMSTUDIO_INGEST).ok, false);
  // terminal states cannot transition
  assert.equal(sm.canTransition('APPROVED', 'REJECTED', sm.SOURCES.OMSTUDIO_INGEST).ok, false);
  assert.equal(sm.canTransition('REJECTED', 'SUBMITTED', sm.SOURCES.OMSTUDIO_INGEST).ok, false);
  // unknown states
  assert.equal(sm.canTransition('NOPE', 'SUBMITTED', sm.SOURCES.BRAIN_SUBMIT).ok, false);
  assert.equal(sm.canTransition('SUBMITTED', 'NOPE', sm.SOURCES.OMSTUDIO_INGEST).ok, false);
});

test('Brain can NEVER self-approve / self-reject / self-expire', () => {
  for (const target of ['APPROVED', 'REJECTED', 'EXPIRED']) {
    const r = sm.canTransition('SUBMITTED', target, sm.SOURCES.BRAIN_SUBMIT);
    assert.equal(r.ok, false, `brain_submit must not set ${target}`);
    assert.match(r.reason, /requires_external_source/);
    // also the literal 'brain' source
    assert.equal(sm.canTransition('SUBMITTED', target, 'brain').ok, false);
  }
});

test('external sources CAN set approved/rejected/expired', () => {
  assert.equal(sm.canTransition('SUBMITTED', 'APPROVED', sm.SOURCES.OMSTUDIO_INGEST).ok, true);
  assert.equal(sm.canTransition('SUBMITTED', 'REJECTED', sm.SOURCES.DRYRUN_SIM).ok, true);
});

test('mapExternalDecision normalizes vendor decision strings', () => {
  assert.equal(sm.mapExternalDecision('approved'), 'APPROVED');
  assert.equal(sm.mapExternalDecision('APPROVE'), 'APPROVED');
  assert.equal(sm.mapExternalDecision('denied'), 'REJECTED');
  assert.equal(sm.mapExternalDecision('reject'), 'REJECTED');
  assert.equal(sm.mapExternalDecision('expired'), 'EXPIRED');
  assert.equal(sm.mapExternalDecision('withdrawn'), 'WITHDRAWN');
  assert.equal(sm.mapExternalDecision('banana'), null);
});

test('isTerminal correctly identifies terminal states', () => {
  assert.equal(sm.isTerminal('APPROVED'), true);
  assert.equal(sm.isTerminal('REJECTED'), true);
  assert.equal(sm.isTerminal('EXPIRED'), true);
  assert.equal(sm.isTerminal('WITHDRAWN'), true);
  assert.equal(sm.isTerminal('SUBMITTED'), false);
  assert.equal(sm.isTerminal('PENDING_SUBMISSION'), false);
});
