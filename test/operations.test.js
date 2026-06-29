'use strict';

process.env.OMBRAIN_FORCE_JSON_BACKEND = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { MemoryDB } = require('../src/memory/db');
const { createServer } = require('../src/api/server');
const { runScan } = require('../src/docRegistry');
const { runOperation, matchOperationIntent } = require('../src/operations');
const { getBuiltinOperations } = require('../src/operations/registry');

const TEST_TMP = '/dev/shm/om-brain-test';

function fixtureDir() {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP, 'ops-'));
}

function freshDb() {
  const db = new MemoryDB({ dbPath: ':memory:', embeddingDim: 8 }).init();
  return { dir: null, db };
}

function fixtureRoots(dir) {
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(path.join(docs, 'om-brain'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'om-brain', 'README.md'), '# Brain Docs\n\nOverview.');
  return {
    schema_version: 1,
    exclude_dir_names: ['node_modules', '.git'],
    exclude_path_globs: [],
    roots: [{ repo: 'omai', path: docs, include_root_md: false }],
  };
}

function fixtureStructure(dir) {
  const omaiHub = path.join(dir, 'docs');
  return {
    schema_version: 1,
    categories: [{ id: 'om-brain' }],
    trees: { omai: { hub_path: omaiHub, folders: ['om-brain/'] } },
    path_rules: [{ match: '/docs/om-brain/', category: 'om-brain' }],
  };
}

test('operation registry seeds built-in operations', () => {
  const { db } = freshDb();
  const ops = db.listOperations();
  assert.ok(ops.length >= 4);
  const ids = ops.map((o) => o.id);
  assert.ok(ids.includes('doc-registry-scan'));
  assert.ok(ids.includes('host-snapshot'));
  assert.ok(ids.includes('schema-snapshot'));
  assert.ok(ids.includes('fleet.find_env_files@v1'));
  assert.deepStrictEqual(getBuiltinOperations().length, 4);
});

test('operation run creates run record', () => {
  const { db } = freshDb();
  const dir = fixtureDir();
  const rootsPath = path.join(dir, 'roots.json');
  const structurePath = path.join(dir, 'structure.json');
  const outPath = path.join(dir, 'DOC-SNAPSHOT.md');
  fs.writeFileSync(rootsPath, JSON.stringify(fixtureRoots(dir)));
  fs.writeFileSync(structurePath, JSON.stringify(fixtureStructure(dir)));

  const out = runOperation(db, 'doc-registry-scan', {
    dry_run: true,
    commit: false,
    rootsPath,
    structurePath,
    outPath,
    triggered_by: 'api',
  });

  assert.strictEqual(out.ok, true);
  assert.ok(out.run_id);
  const run = db.getOperationRun(out.run_id);
  assert.ok(run);
  assert.strictEqual(run.operation_id, 'doc-registry-scan');
  assert.strictEqual(run.status, 'done');
  assert.strictEqual(run.exit_code, 0);
  assert.ok(run.output_summary);
});

test('doc-registry-scan dry-run and commit paths', () => {
  const { db } = freshDb();
  const dir = fixtureDir();
  const rootsPath = path.join(dir, 'roots.json');
  const structurePath = path.join(dir, 'structure.json');
  const outPath = path.join(dir, 'DOC-SNAPSHOT.md');
  fs.writeFileSync(rootsPath, JSON.stringify(fixtureRoots(dir)));
  fs.writeFileSync(structurePath, JSON.stringify(fixtureStructure(dir)));

  const dry = runOperation(db, 'doc-registry-scan', {
    dry_run: true,
    rootsPath,
    structurePath,
    outPath,
  });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.result.dry_run, true);
  assert.strictEqual(db.listDocRegistry({}).length, 0);

  const committed = runOperation(db, 'doc-registry-scan', {
    commit: true,
    dry_run: false,
    rootsPath,
    structurePath,
    outPath,
  });
  assert.strictEqual(committed.ok, true);
  assert.ok(db.listDocRegistry({}).length >= 1);
});

test('failed run records exit_code', () => {
  const { db } = freshDb();
  const out = runOperation(db, 'doc-registry-scan', {
    dry_run: true,
    rootsPath: '/nonexistent/roots.json',
    structurePath: '/nonexistent/structure.json',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 'failed');
  assert.ok(out.exit_code);
  const run = db.getOperationRun(out.run_id);
  assert.strictEqual(run.status, 'failed');
  assert.ok(run.exit_code);
});

test('matchOperationIntent suggests doc-registry-scan', () => {
  const hint = matchOperationIntent('please refresh the doc registry');
  assert.ok(hint);
  assert.strictEqual(hint.operation_id, 'doc-registry-scan');
});

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('GET /brain/operations lists catalog', async () => {
  const { db } = freshDb();
  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { status, json } = await jsonFetch(`http://127.0.0.1:${port}/brain/operations`);
  await new Promise((r) => server.close(r));
  assert.strictEqual(status, 200);
  assert.ok(json.count >= 3);
});

test('POST /brain/operations/:id/run dry-run', async () => {
  const { db } = freshDb();
  const dir = fixtureDir();
  const rootsPath = path.join(dir, 'roots.json');
  const structurePath = path.join(dir, 'structure.json');
  fs.writeFileSync(rootsPath, JSON.stringify(fixtureRoots(dir)));
  fs.writeFileSync(structurePath, JSON.stringify(fixtureStructure(dir)));

  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { status, json } = await jsonFetch(`http://127.0.0.1:${port}/brain/operations/doc-registry-scan/run`, {
    method: 'POST',
    body: { dry_run: true, rootsPath, structurePath, outPath: path.join(dir, 'snap.md') },
  });
  await new Promise((r) => server.close(r));
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.ok(json.run_id);
});
