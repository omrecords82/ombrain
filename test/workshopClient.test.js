'use strict';

/**
 * Tests for the read-only OM Workshop client (.251) — Phase 2 satellite read hook.
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const { WorkshopClient, WORKSHOP_PATHS } = require('../src/adapters/workshopClient');

test('dryrun returns fixtures and never hits the network', async () => {
  const wc = new WorkshopClient({
    transport: 'dryrun',
    fixtures: { status: { service: 'om-workshop', up: true } },
  });
  const r = await wc.getStatus();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transport, 'dryrun');
  assert.strictEqual(r.data.up, true);
});

test('http GET uses injected fetch and only ever issues GET', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ components: 3, sandboxes: 1 }),
    };
  };
  const wc = new WorkshopClient({
    baseUrl: 'http://192.168.1.251:7071',
    transport: 'http',
    httpImpl: fakeFetch,
  });
  const r = await wc.getRegistry();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transport, 'http');
  assert.strictEqual(r.data.components, 3);
  // Read-only guarantee: every issued request is a GET.
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(calls[0].url.endsWith(WORKSHOP_PATHS.registry));
});

test('circuit breaker blocks an external (non-LAN) base url', async () => {
  const wc = new WorkshopClient({
    baseUrl: 'http://workshop.example.com',
    transport: 'http',
    production: true,
    httpImpl: async () => { throw new Error('should not be called'); },
  });
  const r = await wc.getStatus();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.data, null);
});

test('client exposes no write methods (read-only surface)', () => {
  const wc = new WorkshopClient({ transport: 'dryrun' });
  for (const name of ['post', 'put', 'delete', 'launch', 'mutate', 'submit']) {
    assert.strictEqual(typeof wc[name], 'undefined', `unexpected write method: ${name}`);
  }
});

test('health check works in dryrun', async () => {
  const wc = new WorkshopClient({ transport: 'dryrun' });
  const r = await wc.checkHealth();
  assert.strictEqual(r.ok, true);
});
