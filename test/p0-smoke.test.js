'use strict';

/**
 * P0 smoke tests — calendar API routes + orchestrator.ask()
 *
 * Run from the om-brain repo root:
 *   npm test -- --test-name-pattern "P0 smoke"
 */

const test = require('node:test');
const assert = require('node:assert');

test('P0 smoke — getPascha returns a Date for 2026', () => {
  const { getPascha } = require('../src/calendar/index');
  const p = getPascha(2026);
  assert.ok(p instanceof Date, 'getPascha should return a Date');
  assert.strictEqual(p.getUTCFullYear(), 2026);
});

test('P0 smoke — getPascha 2026 is 2026-04-19', () => {
  const { getPascha } = require('../src/calendar/index');
  const p = getPascha(2026);
  assert.strictEqual(p.toISOString().slice(0, 10), '2026-04-19');
});

test('P0 smoke — getMoveableFeasts returns an object', () => {
  const { getMoveableFeasts } = require('../src/calendar/index');
  const feasts = getMoveableFeasts(2026);
  assert.strictEqual(typeof feasts, 'object');
  assert.ok(!Array.isArray(feasts));
  assert.ok('pascha' in feasts);
  assert.ok('pentecost' in feasts);
});

test('P0 smoke — getMoveableFeasts has >= 20 keys', () => {
  const { getMoveableFeasts } = require('../src/calendar/index');
  const feasts = getMoveableFeasts(2026);
  assert.ok(Object.keys(feasts).length >= 20);
});

test('P0 smoke — getFixedFeasts returns an object', () => {
  const { getFixedFeasts } = require('../src/calendar/index');
  const fixed = getFixedFeasts(2026);
  assert.strictEqual(typeof fixed, 'object');
  assert.ok(!Array.isArray(fixed));
  assert.ok('nativity' in fixed);
  assert.ok('theophany' in fixed);
});

test('P0 smoke — getFastingRule Clean Monday 2026', () => {
  const { getFastingRule } = require('../src/calendar/index');
  const cleanMonday = new Date('2026-03-02T12:00:00Z');
  const rule = getFastingRule(cleanMonday);
  assert.ok(rule.level);
  assert.ok(rule.reason);
  assert.strictEqual(rule.level, 'strict_fast');
});

test('P0 smoke — getFastingRule Bright Week is no_fast', () => {
  const { getFastingRule } = require('../src/calendar/index');
  const brightTuesday = new Date('2026-04-21T12:00:00Z');
  const rule = getFastingRule(brightTuesday);
  assert.strictEqual(rule.level, 'no_fast');
});

test('P0 smoke — handleCalendar feasts counts are numbers', async () => {
  const { handleCalendar } = require('../src/queryPipeline/pipeline');
  const result = await handleCalendar('what are the feasts in 2026');
  assert.strictEqual(typeof result.moveableCount, 'number');
  assert.strictEqual(typeof result.fixedCount, 'number');
  assert.ok(result.moveableCount > 0);
  assert.ok(result.fixedCount > 0);
});

test('P0 smoke — handleCalendar pascha query', async () => {
  const { handleCalendar } = require('../src/queryPipeline/pipeline');
  const result = await handleCalendar('when is Pascha 2026');
  assert.strictEqual(result.type, 'calendar.pascha');
  assert.match(result.pascha, /^\d{4}-\d{2}-\d{2}$/);
});

test('P0 smoke — handleCalendar fasting query', async () => {
  const { handleCalendar } = require('../src/queryPipeline/pipeline');
  const result = await handleCalendar('is today a fast day 2026-03-02');
  assert.strictEqual(result.type, 'calendar.fasting');
  assert.ok(result.level);
});

test('P0 smoke — Orchestrator has ask() method', () => {
  const { Orchestrator } = require('../src/orchestrator/orchestrator');
  const o = new Orchestrator({});
  assert.strictEqual(typeof o.ask, 'function');
});

test('P0 smoke — ask() calendar query', async () => {
  const { Orchestrator } = require('../src/orchestrator/orchestrator');
  const o = new Orchestrator({});
  const result = await o.ask('when is Pascha 2026');
  assert.ok(result);
  assert.strictEqual(result.mode, 'calendar');
  assert.ok(typeof result.answer === 'string');
  assert.ok(result.answer.length > 0);
});

test('P0 smoke — ask() prayer query', async () => {
  const { Orchestrator } = require('../src/orchestrator/orchestrator');
  const o = new Orchestrator({});
  const result = await o.ask('what is the Jesus Prayer');
  assert.ok(result);
  assert.strictEqual(result.mode, 'prayer');
  assert.ok(result.answer.includes('Lord Jesus Christ'));
});

test('P0 smoke — ask() general query', async () => {
  const { Orchestrator } = require('../src/orchestrator/orchestrator');
  const o = new Orchestrator({});
  const result = await o.ask('restart the OMAI service');
  assert.ok(result);
  assert.strictEqual(result.mode, 'general');
  assert.ok(typeof result.answer === 'string');
});

test('P0 smoke — ask() empty query', async () => {
  const { Orchestrator } = require('../src/orchestrator/orchestrator');
  const o = new Orchestrator({});
  const result = await o.ask('');
  assert.ok(result);
  assert.ok(typeof result.answer === 'string');
});

test('P0 smoke — AuditorLoop instantiation', () => {
  const { AuditorLoop } = require('../src/auditor/auditorLoop');
  const al = new AuditorLoop({});
  assert.ok(al instanceof AuditorLoop);
});

test('P0 smoke — AuditorLoop.tickOnce() with null db', async () => {
  const { AuditorLoop } = require('../src/auditor/auditorLoop');
  const al = new AuditorLoop({ db: null });
  await assert.doesNotReject(() => al.tickOnce());
});

test('P0 smoke — AuditorLoop.start() disabled', () => {
  const { AuditorLoop } = require('../src/auditor/auditorLoop');
  const { config } = require('../src/config');
  const orig = config.auditor.enabled;
  config.auditor.enabled = false;
  const al = new AuditorLoop({});
  al.start();
  assert.strictEqual(al.timer, null);
  config.auditor.enabled = orig;
});
