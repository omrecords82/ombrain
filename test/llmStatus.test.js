'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  apiKeyPresent,
  inferProvider,
  buildLlmStatus,
  resetProbeCache,
} = require('../src/health/llmStatus');

test('apiKeyPresent treats local-no-key as absent', () => {
  assert.equal(apiKeyPresent({ apiKey: 'local-no-key' }), false);
  assert.equal(apiKeyPresent({ apiKey: 'sk-test' }), true);
});

test('inferProvider detects ollama loopback', () => {
  assert.equal(inferProvider('http://127.0.0.1:11434/v1'), 'ollama');
  assert.equal(inferProvider('http://192.168.1.10:8080/v1'), 'openai-compat');
});

test('buildLlmStatus returns not_configured when base URL missing', async () => {
  resetProbeCache();
  const out = await buildLlmStatus({
    cfg: { baseUrl: '', apiKey: 'local-no-key', reasoningModel: 'test-model' },
    memoryBackend: 'sqlite',
    skipProbe: true,
  });
  assert.equal(out.status, 'not_configured');
  assert.equal(out.memory_backend, 'sqlite');
  assert.equal(out.api_key_present, false);
});

test('buildLlmStatus returns disabled when circuit blocks host', async () => {
  resetProbeCache();
  const out = await buildLlmStatus({
    cfg: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      reasoningModel: 'gpt-test',
    },
    production: false,
    memoryBackend: 'sqlite',
    skipProbe: true,
  });
  assert.equal(out.status, 'disabled');
  assert.ok(out.last_error);
});

test('buildLlmStatus returns available when probe skipped and host allowed', async () => {
  resetProbeCache();
  const out = await buildLlmStatus({
    cfg: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local-no-key',
      reasoningModel: 'qwen-test',
    },
    memoryBackend: 'sqlite',
    skipProbe: true,
  });
  assert.equal(out.status, 'available');
  assert.equal(out.provider, 'ollama');
  assert.equal(out.model, 'qwen-test');
});
