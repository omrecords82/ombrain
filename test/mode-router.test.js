'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ModeRouter, MODES } = require('../src/router/modeRouter');
const { handleKnowledge } = require('../src/handlers/knowledgeHandler');
const { handleTechnical } = require('../src/handlers/technicalHandler');

test('classifyIntent routes action verbs to ops', () => {
  const r = new ModeRouter();
  assert.strictEqual(r.classifyIntent('restart the nginx service'), 'ops');
  assert.strictEqual(r.classifyIntent('please deploy the brain'), 'ops');
  assert.strictEqual(r.classifyIntent('rollback the last release'), 'ops');
});

test('classifyIntent routes platform questions to technical', () => {
  const r = new ModeRouter();
  assert.strictEqual(r.classifyIntent('what is the fleet health status'), 'technical');
  assert.strictEqual(r.classifyIntent('how does the brain health check work'), 'technical');
});

test('classifyIntent defaults knowledge for Orthodox questions', () => {
  const r = new ModeRouter();
  assert.strictEqual(r.classifyIntent('when is pascha 2026'), 'knowledge');
  assert.strictEqual(r.classifyIntent('what is theosis'), 'knowledge');
  assert.strictEqual(r.classifyIntent('find an orthodox church near 10001'), 'knowledge');
});

test('classifyIntent honors configured default for empty input', () => {
  assert.strictEqual(new ModeRouter().classifyIntent(''), 'knowledge');
  assert.strictEqual(new ModeRouter({ defaultMode: 'technical' }).classifyIntent(''), 'technical');
});

test('routeQuery delegates knowledge to the knowledge handler', async () => {
  const r = new ModeRouter();
  const out = await r.routeQuery('when is pascha 2026', {});
  assert.strictEqual(out.mode, 'knowledge');
  assert.strictEqual(out.mode_label, 'Knowledge');
  assert.strictEqual(out.submode, 'calendar');
  assert.ok(out.answer, 'should return an answer string');
});

test('routeQuery delegates technical to the technical handler', async () => {
  const r = new ModeRouter();
  const out = await r.routeQuery('what is the fleet health status', {});
  assert.strictEqual(out.mode, 'technical');
  assert.strictEqual(out.mode_label, 'Technical');
  assert.ok(out.answer);
});

test('handleKnowledge stamps mode metadata for each submode', async () => {
  const study = await handleKnowledge('what is theosis', {});
  assert.strictEqual(study.mode, 'knowledge');
  assert.strictEqual(study.submode, 'study');
  assert.ok(study.mode_description);

  const prayer = await handleKnowledge('teach me the jesus prayer', {});
  assert.strictEqual(prayer.submode, 'prayer');
});

test('handleTechnical flags action-class requests as requiring governance', async () => {
  const out = await handleTechnical('restart the nginx service', {});
  assert.strictEqual(out.mode, 'technical');
  assert.strictEqual(out.requires_governance, true);
});

test('listModes exposes the three communication modes with labels', () => {
  const r = new ModeRouter();
  const ids = r.listModes().map((m) => m.id).sort();
  assert.deepStrictEqual(ids, ['knowledge', 'ops', 'technical']);
  assert.strictEqual(MODES.length, 3);
  for (const m of MODES) {
    assert.ok(m.label && m.description, `${m.id} has label+description`);
  }
});
