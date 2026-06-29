'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { MemoryDB } = require('../src/memory/db');
const { createServer } = require('../src/api/server');
const {
  scanFilesystem,
  runScan,
  classifyPath,
  inferTitle,
} = require('../src/docRegistry');

const TEST_TMP = path.join(__dirname, '..', '.test-tmp');

function freshDb() {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'brain-docreg-'));
  const db = new MemoryDB({ dbPath: path.join(dir, 'brain.db'), embeddingDim: 8 }).init();
  return { dir, db };
}

function fixtureRoots(dir) {
  const docs = path.join(dir, 'docs');
  const omDocs = path.join(dir, 'om', 'docs');
  fs.mkdirSync(path.join(docs, 'om-brain'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'coordination'), { recursive: true });
  fs.mkdirSync(path.join(omDocs, 'platform'), { recursive: true });
  fs.writeFileSync(
    path.join(docs, 'om-brain', 'README.md'),
    '# Brain Docs\n\nArchitecture overview.',
  );
  fs.writeFileSync(
    path.join(docs, 'coordination', 'handoff.md'),
    '# Handoff\n\nCurrent work.',
  );
  fs.writeFileSync(
    path.join(omDocs, 'platform', 'map.md'),
    '# Platform Map\n\nHosts.',
  );
  const duplicate = path.join(dir, 'scratch', 'copy.md');
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.writeFileSync(duplicate, '# Brain Docs\n\nArchitecture overview.');

  return {
    schema_version: 1,
    exclude_dir_names: ['node_modules', '.git'],
    exclude_path_globs: [],
    roots: [
      { repo: 'omai', path: docs, include_root_md: false },
      { repo: 'om', path: omDocs, include_root_md: false },
      { repo: 'omai', path: path.join(dir, 'scratch'), include_root_md: false },
    ],
  };
}

function fixtureStructure(dir) {
  const omHub = path.join(dir, 'om', 'docs');
  const omaiHub = path.join(dir, 'docs');
  return {
    schema_version: 1,
    categories: [{ id: 'platform' }, { id: 'om-brain' }, { id: 'coordination' }],
    trees: {
      om: { hub_path: omHub, folders: ['platform/', 'missing-folder/'] },
      omai: { hub_path: omaiHub, folders: ['README.md', 'om-brain/'] },
    },
    path_rules: [
      { match: '/docs/om-brain/', category: 'om-brain' },
      { match: '/docs/coordination/', category: 'coordination' },
      { match: '/docs/platform/', category: 'platform' },
    ],
  };
}

test('inferTitle extracts first heading', () => {
  assert.strictEqual(inferTitle('# Hello World\n\nbody', '/x.md'), 'Hello World');
  assert.strictEqual(inferTitle('no heading', '/my-file.md'), 'my file');
});

test('classifyPath applies path rules', () => {
  const structure = { path_rules: [{ match: '/docs/om-brain/', category: 'om-brain' }] };
  const r = classifyPath('/var/www/omai/docs/om-brain/x.md', 'omai', structure);
  assert.strictEqual(r.category, 'om-brain');
});

test('scanFilesystem finds fixtures and marks duplicates', () => {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'docscan-'));
  const rootsPath = path.join(dir, 'roots.json');
  const structurePath = path.join(dir, 'structure.json');
  fs.writeFileSync(rootsPath, JSON.stringify(fixtureRoots(dir)));
  fs.writeFileSync(structurePath, JSON.stringify(fixtureStructure(dir)));

  const entries = scanFilesystem({ rootsPath, structurePath });
  assert.ok(entries.length >= 3);
  const dupes = entries.filter((e) => e.status === 'duplicate');
  assert.ok(dupes.length >= 1, 'expected at least one duplicate by sha256');
});

test('MemoryDB doc registry CRUD', () => {
  const { db } = freshDb();
  db.upsertDocRegistry({
    path: '/tmp/a.md',
    repo: 'omai',
    category: 'om-brain',
    title: 'A',
    status: 'canonical',
    last_scanned_at: new Date().toISOString(),
  });
  const rows = db.listDocRegistry({ repo: 'omai' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'A');
});

test('runScan commit persists and writes snapshot', () => {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'docrun-'));
  const { db } = freshDb();
  const rootsPath = path.join(dir, 'roots.json');
  const structurePath = path.join(dir, 'structure.json');
  const outPath = path.join(dir, 'DOC-SNAPSHOT.md');
  fs.writeFileSync(rootsPath, JSON.stringify(fixtureRoots(dir)));
  fs.writeFileSync(structurePath, JSON.stringify(fixtureStructure(dir)));

  const result = runScan(db, { commit: true, rootsPath, structurePath, outPath });
  assert.ok(fs.existsSync(outPath));
  assert.ok(result.stats.total >= 3);
  const stored = db.listDocRegistry({});
  assert.ok(stored.length >= 3);
  assert.match(fs.readFileSync(outPath, 'utf8'), /Do not edit manually/);
});

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('GET /brain/docs/structure returns canonical tree', async () => {
  const { db } = freshDb();
  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { status, json } = await jsonFetch(`http://127.0.0.1:${port}/brain/docs/structure`);
  await new Promise((r) => server.close(r));
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.ok(json.structure.categories);
});

test('POST /brain/docs/scan requires auth', async () => {
  const prev = process.env.BRAIN_INGEST_SECRET;
  process.env.BRAIN_INGEST_SECRET = 'test-scan-secret';
  const { db } = freshDb();
  const app = createServer({ db });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const { status } = await jsonFetch(`http://127.0.0.1:${port}/brain/docs/scan`, { method: 'POST', body: {} });
  await new Promise((r) => server.close(r));
  if (prev === undefined) delete process.env.BRAIN_INGEST_SECRET;
  else process.env.BRAIN_INGEST_SECRET = prev;
  assert.strictEqual(status, 401);
});
