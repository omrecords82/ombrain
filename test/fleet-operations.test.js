'use strict';

process.env.OMBRAIN_FORCE_JSON_BACKEND = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const { MemoryDB } = require('../src/memory/db');
const { createServer } = require('../src/api/server');
const { matchOperationIntent, runFleetOperation } = require('../src/operations');
const { getBuiltinOperation } = require('../src/operations/registry');
const { redactFleetResult } = require('../src/fleet/redact');
const { dispatchFleetOperation } = require('../src/fleet/dispatcher');

const ROOT = path.resolve(__dirname, '..');
const HANDLER = 'scripts/fleet/handlers/find-env-files.sh';

function freshDb() {
  return new MemoryDB({ dbPath: ':memory:', embeddingDim: 8 }).init();
}

function fixtureTree(base) {
  fs.mkdirSync(path.join(base, 'var', 'www', 'app'), { recursive: true });
  fs.mkdirSync(path.join(base, 'var', 'www', 'app', 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(base, 'var', 'www', 'app', '.git'), { recursive: true });
  fs.mkdirSync(path.join(base, 'opt', 'svc'), { recursive: true });
  fs.writeFileSync(path.join(base, 'var', 'www', 'app', '.env'), 'SECRET=must-not-appear\n');
  fs.writeFileSync(path.join(base, 'var', 'www', 'app', '.env.local'), 'KEY=val\n');
  fs.writeFileSync(path.join(base, 'var', 'www', 'app', 'node_modules', 'pkg', '.env'), 'SKIP=1\n');
  fs.writeFileSync(path.join(base, 'opt', 'svc', '.env.production'), 'PROD=1\n');
}

test('fleet operation registered with spawn_mode fleet_ssh', () => {
  const op = getBuiltinOperation('fleet.find_env_files@v1');
  assert.ok(op);
  assert.strictEqual(op.spawn_mode, 'fleet_ssh');
  assert.strictEqual(op.transport, 'ssh');
  assert.strictEqual(op.script_ref, HANDLER);
});

test('handler script outputs valid JSON schema locally', () => {
  const dir = fs.mkdtempSync(path.join('/dev/shm', 'fleet-handler-'));
  fixtureTree(dir);
  const scanRoots = `${path.join(dir, 'var', 'www')}:${path.join(dir, 'opt')}`;
  const proc = spawnSync('bash', [path.join(ROOT, HANDLER)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOSTNAME: 'test-host', FLEET_SCAN_ROOTS: scanRoots },
  });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout.trim());
  assert.strictEqual(parsed.hostname, 'test-host');
  assert.ok(Array.isArray(parsed.paths));
  assert.ok(Array.isArray(parsed.errors));
  assert.strictEqual(typeof parsed.count, 'number');
  const joined = proc.stdout + proc.stderr;
  assert.ok(!joined.includes('SECRET=must-not-appear'));
  assert.ok(!joined.includes('KEY=val'));
});

test('handler excludes node_modules and .git', () => {
  const dir = fs.mkdtempSync(path.join('/dev/shm', 'fleet-excl-'));
  fixtureTree(dir);
  const scanRoots = `${path.join(dir, 'var', 'www')}:${path.join(dir, 'opt')}`;
  const proc = spawnSync('bash', [path.join(ROOT, HANDLER)], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOSTNAME: 'test-host', FLEET_SCAN_ROOTS: scanRoots },
  });
  const parsed = JSON.parse(proc.stdout.trim());
  assert.ok(parsed.paths.every((p) => !p.includes('node_modules')));
  assert.ok(parsed.paths.every((p) => !p.includes('.git')));
  assert.ok(parsed.count >= 2);
});

test('redactFleetResult redacts KEY=value strings', () => {
  const out = redactFleetResult({
    hostname: 'x',
    paths: ['/var/www/.env'],
    count: 1,
    errors: ['DB_PASSWORD=secret'],
  });
  assert.strictEqual(out.errors[0], '[REDACTED]');
});

test('mock transport creates parent and child runs', async () => {
  const db = freshDb();
  const mockResult = {
    hostname: 'om-prod01',
    paths: ['/var/www/omai/.env'],
    count: 1,
    errors: [],
  };
  const transportImpl = {
    execute: () => ({
      stdout: JSON.stringify(mockResult),
      stderr: '',
      exit_code: 0,
    }),
  };

  const out = await runFleetOperation(db, 'fleet.find_env_files@v1', {
    targets: ['om-prod01'],
    triggered_by: 'test',
    transportImpl,
  });

  assert.strictEqual(out.ok, true);
  assert.ok(out.report);
  assert.strictEqual(out.report.summary.hosts_requested, 1);
  assert.strictEqual(out.report.summary.hosts_ok, 1);
  assert.strictEqual(out.report.summary.total_paths, 1);

  const parent = db.getOperationRun(out.run_id);
  assert.strictEqual(parent.status, 'done');
  const children = db.listOperationRunChildren(out.run_id);
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].host, 'om-prod01');
  assert.strictEqual(children[0].transport, 'ssh');
  assert.strictEqual(children[0].exit_code, 0);
});

test('matchOperationIntent suggests fleet env scan', () => {
  const hint = matchOperationIntent('please find env files on prod');
  assert.ok(hint);
  assert.strictEqual(hint.operation_id, 'fleet.find_env_files@v1');
  assert.strictEqual(hint.fleet, true);
});

test('ssh transport rejects non-allowlisted handler', () => {
  const sshTransport = require('../src/fleet/transports/ssh');
  assert.throws(
    () => sshTransport.assertAllowlistedHandler('scripts/collect-hosts.js'),
    /not allowlisted/,
  );
});

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('POST fleet operation via API with local dispatch', async () => {
  const db = freshDb();
  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const opId = encodeURIComponent('fleet.find_env_files@v1');
  const { status, json } = await jsonFetch(`http://127.0.0.1:${port}/brain/operations/${opId}/run`, {
    method: 'POST',
    body: { description: 'api test', local: true },
  });
  await new Promise((r) => server.close(r));

  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.ok(json.report);
  assert.ok(json.report.hosts);
});

test('GET /brain/operations/runs/:id includes children', async () => {
  const db = freshDb();
  const out = await runFleetOperation(db, 'fleet.find_env_files@v1', {
    targets: ['om-prod01'],
    local: true,
    triggered_by: 'test',
  });

  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { status, json } = await jsonFetch(`http://127.0.0.1:${port}/brain/operations/runs/${out.run_id}`);
  await new Promise((r) => server.close(r));

  assert.strictEqual(status, 200);
  assert.ok(json.run);
  assert.ok(Array.isArray(json.children));
  assert.strictEqual(json.children.length, 1);
});
