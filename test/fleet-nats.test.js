'use strict';

process.env.OMBRAIN_FORCE_JSON_BACKEND = '1';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { StringCodec } = require('nats');

const { MemoryDB } = require('../src/memory/db');
const { runFleetOperation } = require('../src/operations');
const { getBuiltinOperation } = require('../src/operations/registry');
const {
  assertLanNatsUrl,
  spawnSubject,
  resolveFleetTransport,
  isPrivateOrLoopbackHost,
} = require('../src/fleet/natsClient');
const {
  assertAllowlistedOperation,
  assertAllowlistedHandler,
} = require('../src/fleet/handlers');
const { ROOT } = require('../src/fleet/hosts');

const sc = StringCodec();
const HANDLER = 'scripts/fleet/handlers/find-env-files.sh';

function freshDb() {
  return new MemoryDB({ dbPath: ':memory:', embeddingDim: 8 }).init();
}

/**
 * In-process NATS harness: mock connection with request/reply over a Map of handlers.
 */
function createMockNatsHarness(hostId) {
  const handlers = new Map();

  const nc = {
    isClosed: () => false,
    subscribe(subject, opts = {}) {
      const queue = opts.queue || 'default';
      const key = `${subject}:${queue}`;
      handlers.set(key, opts.callback || null);
      return {
        async *[Symbol.asyncIterator]() {
          // iterator unused in tests — we call dispatch directly
        },
      };
    },
    async request(subject, data, _opts) {
      const key = `${subject}:satellite-${hostId}`;
      const cb = handlers.get(key);
      if (!cb) {
        const err = new Error('503');
        err.code = '503';
        throw err;
      }
      const inbox = `_INBOX.test.${Date.now()}`;
      let replyPayload = null;
      const msg = {
        data,
        reply: inbox,
      };
      const subCb = (replyMsg) => {
        replyPayload = replyMsg.data;
      };
      handlers.set(`${inbox}:`, subCb);
      await cb(err => { if (err) throw err; }, msg);
      // Simulate satellite publish to reply
      const replyHandler = handlers.get(`${inbox}:`);
      if (replyHandler && replyPayload == null) {
        // callback-style satellite worker
      }
      return { data: replyPayload || sc.encode(JSON.stringify({
        stdout: JSON.stringify({ hostname: hostId, paths: ['/var/www/omai/.env'], count: 1, errors: [] }),
        stderr: '',
        exit_code: 0,
      })) };
    },
    publish(reply, data) {
      for (const [key, cb] of handlers) {
        if (key.startsWith(`${sc.decode(reply)}:`) || key === `${sc.decode(reply)}:`) {
          if (cb) cb(null, { data });
        }
      }
    },
    async close() {},
  };

  return { nc, subject: spawnSubject(hostId) };
}

test('fleet operation defaults to nats transport', () => {
  const op = getBuiltinOperation('fleet.find_env_files@v1');
  assert.strictEqual(op.transport, 'nats');
});

test('spawnSubject names host-scoped subject', () => {
  assert.strictEqual(spawnSubject('om-prod01'), 'brain.fleet.spawn.om-prod01');
});

test('assertLanNatsUrl allows LAN and loopback', () => {
  assert.doesNotThrow(() => assertLanNatsUrl('nats://127.0.0.1:4222'));
  assert.doesNotThrow(() => assertLanNatsUrl('nats://192.168.1.254:4222'));
});

test('assertLanNatsUrl blocks external hosts', () => {
  assert.throws(
    () => assertLanNatsUrl('nats://broker.example.com:4222'),
    /LAN\/loopback/,
  );
});

test('isPrivateOrLoopbackHost RFC1918', () => {
  assert.strictEqual(isPrivateOrLoopbackHost('10.0.0.1'), true);
  assert.strictEqual(isPrivateOrLoopbackHost('172.16.0.1'), true);
  assert.strictEqual(isPrivateOrLoopbackHost('192.168.1.254'), true);
  assert.strictEqual(isPrivateOrLoopbackHost('8.8.8.8'), false);
});

test('resolveFleetTransport honors FLEET_TRANSPORT', () => {
  const prev = process.env.FLEET_TRANSPORT;
  process.env.FLEET_TRANSPORT = 'ssh';
  assert.strictEqual(resolveFleetTransport(), 'ssh');
  process.env.FLEET_TRANSPORT = 'nats';
  assert.strictEqual(resolveFleetTransport(), 'nats');
  if (prev === undefined) delete process.env.FLEET_TRANSPORT;
  else process.env.FLEET_TRANSPORT = prev;
});

test('allowlist rejects unknown operation and handler', () => {
  assert.throws(() => assertAllowlistedOperation('evil.op@v1'), /not allowlisted/);
  assert.throws(
    () => assertAllowlistedHandler('scripts/collect-hosts.js', ROOT),
    /not allowlisted/,
  );
  assert.doesNotThrow(() => assertAllowlistedHandler(HANDLER, ROOT));
});

test('mock nats transportImpl completes fleet operation', async () => {
  const db = freshDb();
  const mockResult = {
    hostname: 'om-prod01',
    paths: ['/var/www/omai/.env', '/var/www/orthodoxmetrics/prod/.env'],
    count: 2,
    errors: [],
  };
  const transportImpl = {
    execute: async (_host, _handler, _env, meta) => {
      assert.ok(meta.runId);
      assert.ok(meta.parentRunId);
      assert.strictEqual(meta.operationId, 'fleet.find_env_files@v1');
      return {
        stdout: JSON.stringify(mockResult),
        stderr: '',
        exit_code: 0,
      };
    },
  };

  const out = await runFleetOperation(db, 'fleet.find_env_files@v1', {
    targets: ['om-prod01'],
    transport: 'nats',
    transportImpl,
    triggered_by: 'test',
  });

  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.report.summary.total_paths, 2);
  const children = db.listOperationRunChildren(out.run_id);
  assert.strictEqual(children[0].transport, 'nats');
});

test('nats transport returns error when satellite unreachable', async () => {
  const natsTransport = require('../src/fleet/transports/nats');
  const orig = process.env.NATS_URL;
  process.env.NATS_URL = 'nats://127.0.0.1:59999';

  const { closeNatsConnection } = require('../src/fleet/natsClient');
  await closeNatsConnection();

  const hostConfig = { name: 'om-prod01', ip: '192.168.1.239' };
  const out = await natsTransport.execute(hostConfig, HANDLER, {}, {
    runId: 'child-1',
    parentRunId: 'parent-1',
    operationId: 'fleet.find_env_files@v1',
  });

  assert.strictEqual(out.exit_code, 1);
  assert.ok(out.stderr);

  if (orig === undefined) delete process.env.NATS_URL;
  else process.env.NATS_URL = orig;
  await closeNatsConnection();
});
