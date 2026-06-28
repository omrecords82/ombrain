'use strict';

/**
 * Live-embedding wiring tests (Phase 2): BrainAIClient.embed() + createRagRetriever.
 * Offline — uses injected transports, no openai SDK / network required.
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { BrainAIClient } = require('../src/ai/client');
const { createRagRetriever, deterministicEmbed } = require('../src/memory/ragRetriever');

// A LAN base URL so the circuit breaker permits the call in these tests.
const LAN_CFG = { baseUrl: 'http://127.0.0.1:11434/v1' };

test('client.embed() returns a vector via injected transport (breaker-allowed)', async () => {
  const ai = new BrainAIClient({
    cfg: LAN_CFG,
    production: false,
    embedTransport: async ({ input }) => ({ vector: [input.length, 1, 2] }),
  });
  const res = await ai.embed('hello');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.vector, [5, 1, 2]);
});

test('client.embed() redacts secret-shaped values before sending', async () => {
  let seen = null;
  const ai = new BrainAIClient({
    cfg: LAN_CFG,
    production: false,
    embedTransport: async ({ input }) => { seen = input; return { vector: [0] }; },
  });
  await ai.embed('use Bearer abc123tokenvalue to authenticate');
  // redactForModel must mask secret-shaped values (e.g. Bearer tokens) in free text.
  assert.ok(!/abc123tokenvalue/.test(seen), 'raw bearer token must not reach the transport');
  assert.ok(/REDACTED/.test(seen), 'redaction marker should be present');
});

test('client.embed() blocks an external host via circuit breaker', async () => {
  const ai = new BrainAIClient({
    cfg: { baseUrl: 'https://api.openai.com/v1' },
    production: true,
    embedTransport: async () => ({ vector: [1] }),
  });
  const res = await ai.embed('x');
  assert.strictEqual(res.ok, false);
  assert.ok(res.escalation, 'should return an escalation, not a vector');
});

test('createRagRetriever uses the live embedder when it succeeds', async () => {
  const ai = {
    embed: async (t) => ({ ok: true, vector: t.includes('match') ? [1, 0, 0] : [0, 1, 0] }),
  };
  const r = createRagRetriever({ aiClient: ai });
  const out = await r.retrieve('please match', [
    { id: 'a', body: 'a match row' },
    { id: 'b', body: 'other' },
  ], { k: 2 });
  assert.strictEqual(out[0].id, 'a');
});

test('createRagRetriever falls back to deterministic embedder when live embed fails', async () => {
  let warned = 0;
  const ai = { embed: async () => ({ ok: false, escalation: { reason: 'inference_unavailable' } }) };
  const r = createRagRetriever({
    aiClient: ai,
    logger: { info: () => {}, warn: () => { warned++; } },
  });
  // Should still rank deterministically (same as the pure fallback embedder).
  const rows = [
    { id: 1, body: 'Saint John Chrysostom liturgy' },
    { id: 2, body: 'car tire change' },
  ];
  const out = await r.retrieve('Chrysostom liturgy', rows, { k: 2 });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 1, 'deterministic fallback should still rank the relevant row first');
  assert.ok(warned >= 1, 'fallback must be logged (observable degradation)');
});

test('createRagRetriever falls back when live embed throws', async () => {
  const ai = { embed: async () => { throw new Error('boom'); } };
  const r = createRagRetriever({ aiClient: ai, logger: { info() {}, warn() {} } });
  const out = await r.retrieve('alpha', [{ id: 1, body: 'alpha beta' }], { k: 1 });
  assert.strictEqual(out.length, 1);
});

test('createRagRetriever uses deterministic embedder when live disabled / no client', async () => {
  const r1 = createRagRetriever({ liveEmbeddingsEnabled: false });
  assert.strictEqual(r1.usingFallback, true);
  const r2 = createRagRetriever({});
  assert.strictEqual(r2.usingFallback, true);
  // sanity: deterministic embedder is wired
  const v = deterministicEmbed('x', 256);
  assert.strictEqual(v.length, 256);
});
