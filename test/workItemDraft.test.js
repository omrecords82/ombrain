'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  prefixToRepoTarget,
  formatWorkItemCode,
  validateDraftInput,
} = require('../../_runtime/server/src/services/workItemDraft');

test('prefixToRepoTarget maps OMOD/OMAD/OMSD', () => {
  assert.strictEqual(prefixToRepoTarget('OMOD'), 'orthodoxmetrics');
  assert.strictEqual(prefixToRepoTarget('omad'), 'omai');
  assert.strictEqual(prefixToRepoTarget('OMSD'), 'omstudio');
  assert.strictEqual(prefixToRepoTarget('UNKNOWN'), null);
});

test('formatWorkItemCode uses repo prefix', () => {
  assert.strictEqual(formatWorkItemCode(42, 'orthodoxmetrics'), 'OMOD-42');
  assert.strictEqual(formatWorkItemCode(7, 'omai'), 'OMAD-7');
  assert.strictEqual(formatWorkItemCode(3, null), 'OMD-3');
});

test('validateDraftInput requires title', () => {
  assert.throws(() => validateDraftInput({}), (err) => err.code === 'title_required');
  assert.strictEqual(validateDraftInput({ title: '  hello  ' }), 'hello');
});
