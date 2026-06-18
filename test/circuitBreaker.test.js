'use strict';

const test = require('node:test');
const assert = require('node:assert');
const breaker = require('../src/ai/circuitBreaker');
const { BrainAIClient } = require('../src/ai/client');

// --- host classification ---------------------------------------------------

test('blocks api.openai.com in all modes', () => {
  assert.strictEqual(breaker.checkHost('https://api.openai.com/v1', { production: false }).allowed, false);
  assert.strictEqual(breaker.checkHost('https://api.openai.com/v1', { production: true }).allowed, false);
  assert.strictEqual(
    breaker.checkHost('https://api.openai.com/v1', { production: true }).reason,
    'external_llm_host_blocked',
  );
});

test('blocks other external LLM hosts', () => {
  for (const h of [
    'https://api.anthropic.com',
    'https://api.mistral.ai/v1',
    'https://generativelanguage.googleapis.com',
    'https://api.groq.com/openai/v1',
  ]) {
    assert.strictEqual(breaker.checkHost(h, { production: true }).allowed, false, h);
  }
});

test('allows loopback and RFC1918 LAN hosts', () => {
  assert.ok(breaker.checkHost('http://127.0.0.1:11434/v1', { production: true }).allowed);
  assert.ok(breaker.checkHost('http://localhost:11434/v1', { production: true }).allowed);
  assert.ok(breaker.checkHost('http://192.168.1.254:11434/v1', { production: true }).allowed);
  assert.ok(breaker.checkHost('http://10.0.0.5:11434/v1', { production: true }).allowed);
  assert.ok(breaker.checkHost('http://172.16.4.4:11434/v1', { production: true }).allowed);
});

test('blocks a public non-LAN host in production', () => {
  const v = breaker.checkHost('https://example.com/v1', { production: true });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.reason, 'non_lan_host_blocked_in_production');
});

test('blocks a public non-LAN host in development too', () => {
  const v = breaker.checkHost('https://example.com/v1', { production: false });
  assert.strictEqual(v.allowed, false);
});

test('isRfc1918 boundaries', () => {
  assert.ok(breaker.isRfc1918('192.168.0.1'));
  assert.ok(breaker.isRfc1918('172.31.255.255'));
  assert.ok(!breaker.isRfc1918('172.32.0.1'));
  assert.ok(!breaker.isRfc1918('11.0.0.1'));
  assert.ok(!breaker.isRfc1918('8.8.8.8'));
});

// --- client integration: breaker prevents external calls -------------------

test('AIClient.assertEndpointAllowed throws for external host in production', () => {
  const client = new BrainAIClient({ cfg: { baseUrl: 'https://api.openai.com/v1' }, production: true });
  assert.throws(() => client.assertEndpointAllowed(), /circuit_breaker_block/);
});

test('AIClient diagnostic returns escalation (not a call) for blocked host', async () => {
  let transportCalled = false;
  const client = new BrainAIClient({
    cfg: { baseUrl: 'https://api.openai.com/v1', reasoningModel: 'x' },
    production: true,
    transport: async () => {
      transportCalled = true;
      return { content: 'should never run' };
    },
  });
  const res = await client.diagnostic({ doctrine: '', systemTruth: {}, incident: {}, sessionId: 's1' });
  assert.strictEqual(res.ok, false);
  assert.ok(res.escalation);
  assert.strictEqual(res.escalation.cause, 'circuit_breaker');
  assert.strictEqual(res.escalation.classification, 'requires_human_superadmin');
  assert.strictEqual(transportCalled, false, 'transport must NOT be called when host is blocked');
});

test('AIClient diagnostic allows LAN host and uses injected transport', async () => {
  const client = new BrainAIClient({
    cfg: { baseUrl: 'http://127.0.0.1:11434/v1', reasoningModel: 'qwen' },
    production: true,
    transport: async ({ messages }) => {
      // ensure secrets were redacted before reaching transport
      const blob = JSON.stringify(messages);
      assert.ok(!blob.includes('hunter2'));
      return { content: 'ok-analysis' };
    },
  });
  const res = await client.diagnostic({
    doctrine: 'rules',
    systemTruth: { x: 1 },
    incident: { DB_PASSWORD: 'hunter2', note: 'test' },
    sessionId: 's2',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.content, 'ok-analysis');
});

test('on local inference failure the breaker escalates, never re-routes', async () => {
  const client = new BrainAIClient({
    cfg: { baseUrl: 'http://127.0.0.1:11434/v1', reasoningModel: 'qwen' },
    production: true,
    transport: async () => {
      throw new Error('connection refused');
    },
  });
  const res = await client.diagnostic({ doctrine: '', systemTruth: {}, incident: {}, sessionId: 's3' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.escalation.cause, 'inference_failure');
  assert.strictEqual(res.escalation.action, 'halt_and_escalate');
});
