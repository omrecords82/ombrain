'use strict';

/**
 * RAG Retriever tests (Phase 2 memory-layer expansion).
 * All offline — deterministic fallback embedder, no LiteLLM/network.
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { RagRetriever, deterministicEmbed } = require('../src/memory/ragRetriever');
const { encodeVector } = require('../src/memory/vectorStore');

test('deterministic embedder is stable and L2-normalized', () => {
  const a = deterministicEmbed('Pascha is the feast of feasts');
  const b = deterministicEmbed('Pascha is the feast of feasts');
  assert.deepStrictEqual(a, b);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9 || norm === 0);
});

test('retrieve ranks higher-overlap text above unrelated text', async () => {
  const r = new RagRetriever();
  const rows = [
    { id: 1, body: 'The Divine Liturgy of Saint John Chrysostom' },
    { id: 2, body: 'How to change a car tire safely' },
    { id: 3, body: 'Saint John Chrysostom on prayer and almsgiving' },
  ];
  const out = await r.retrieve('Saint John Chrysostom liturgy', rows, { k: 3 });
  assert.strictEqual(out.length, 3);
  // The two Chrysostom rows should outrank the car-tire row.
  const tireRank = out.findIndex((x) => x.id === 2);
  assert.strictEqual(tireRank, out.length - 1, 'unrelated row should rank last');
});

test('respects k and minScore', async () => {
  const r = new RagRetriever();
  const rows = [
    { id: 1, body: 'alpha beta gamma' },
    { id: 2, body: 'delta epsilon zeta' },
    { id: 3, body: 'alpha beta delta' },
  ];
  const top1 = await r.retrieve('alpha beta', rows, { k: 1 });
  assert.strictEqual(top1.length, 1);
  const filtered = await r.retrieve('alpha beta', rows, { k: 5, minScore: 0.99 });
  assert.ok(filtered.every((x) => x.score >= 0.99));
});

test('uses an injected (e.g. LiteLLM) embed function when provided', async () => {
  let called = 0;
  const fakeEmbed = (text) => { called++; return text.includes('match') ? [1, 0, 0] : [0, 1, 0]; };
  const r = new RagRetriever({ embed: fakeEmbed });
  assert.strictEqual(r.usingFallback, false);
  const rows = [
    { id: 'a', body: 'this is a match row' },
    { id: 'b', body: 'this is other' },
  ];
  const out = await r.retrieve('please match', rows, { k: 2 });
  assert.strictEqual(out[0].id, 'a');
  assert.ok(called >= 3); // query + 2 rows
});

test('decodes Float32 BLOB vectors stored on rows', async () => {
  const r = new RagRetriever({ embed: (t) => (t === 'q' ? [1, 0, 0] : [0, 0, 1]) });
  const rows = [
    { id: 1, body: 'ignored', embedding: encodeVector([1, 0, 0]) }, // identical to query
    { id: 2, body: 'ignored', embedding: encodeVector([0, 1, 0]) },
  ];
  const out = await r.retrieve('q', rows, { k: 2, vectorField: 'embedding' });
  assert.strictEqual(out[0].id, 1);
  assert.ok(out[0].score > out[1].score);
});

test('empty inputs return empty', async () => {
  const r = new RagRetriever();
  assert.deepStrictEqual(await r.retrieve('', [{ id: 1, body: 'x' }]), []);
  assert.deepStrictEqual(await r.retrieve('x', []), []);
});
