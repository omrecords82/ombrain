'use strict';

/**
 * Tests for scripts/backfill-embeddings.js — offline, in-memory SQLite.
 * Verifies dry-run safety, only-missing vs all, theological immutability
 * gating + trigger restoration, batching, and failure counting.
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const {
  parseArgs, backfillTable, rowText, ALLOWED_TABLES, THEO_TRIGGERS,
} = require('../scripts/backfill-embeddings');
const { decodeVector } = require('../src/memory/vectorStore');
const { deterministicEmbed } = require('../src/memory/ragRetriever');

const SILENT = { info() {}, warn() {} };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE knowledge_memory (
      id TEXT PRIMARY KEY, slug TEXT, title TEXT, body TEXT, category TEXT,
      embedding BLOB
    );
    CREATE TABLE theological_memory (
      id TEXT PRIMARY KEY, category TEXT, reference_key TEXT, title TEXT,
      body TEXT, source TEXT, embedding BLOB
    );
  `);
  for (const t of THEO_TRIGGERS) db.exec(t.sql);
  return db;
}

function seedKnowledge(db, n) {
  const ins = db.prepare('INSERT INTO knowledge_memory (id,slug,title,body,category) VALUES (?,?,?,?,?)');
  for (let i = 0; i < n; i += 1) ins.run(`k${i}`, `slug-${i}`, `Title ${i}`, `body content ${i}`, 'general');
}

const liveEmbed = async (text) => deterministicEmbed(text, 256);

test('parseArgs defaults to dry-run, only-missing, knowledge_memory', () => {
  const a = parseArgs([]);
  assert.strictEqual(a.commit, false);
  assert.strictEqual(a.mode, 'only-missing');
  assert.deepStrictEqual(a.tables, ['knowledge_memory']);
});

test('parseArgs reads flags', () => {
  const a = parseArgs(['--commit', '--all', '--tables=knowledge_memory,theological_memory', '--batch=10', '--allow-theological']);
  assert.strictEqual(a.commit, true);
  assert.strictEqual(a.mode, 'all');
  assert.deepStrictEqual(a.tables, ['knowledge_memory', 'theological_memory']);
  assert.strictEqual(a.batch, 10);
  assert.strictEqual(a.allowTheological, true);
});

test('parseArgs rejects unknown option', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('rowText joins configured text columns', () => {
  assert.strictEqual(rowText({ title: 'A', body: 'B' }, ['title', 'body']), 'A\nB');
});

test('dry-run writes nothing', async () => {
  const db = makeDb();
  seedKnowledge(db, 3);
  const stat = await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs([]), SILENT);
  assert.strictEqual(stat.embedded, 3);
  const withVec = db.prepare('SELECT COUNT(*) c FROM knowledge_memory WHERE embedding IS NOT NULL').get().c;
  assert.strictEqual(withVec, 0, 'dry-run must not write embeddings');
});

test('commit writes decodable vectors to knowledge_memory', async () => {
  const db = makeDb();
  seedKnowledge(db, 3);
  const stat = await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit']), SILENT);
  assert.strictEqual(stat.embedded, 3);
  const row = db.prepare('SELECT embedding FROM knowledge_memory WHERE id = ?').get('k0');
  const vec = decodeVector(row.embedding);
  assert.strictEqual(vec.length, 256);
});

test('only-missing skips rows that already have an embedding', async () => {
  const db = makeDb();
  seedKnowledge(db, 3);
  await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit']), SILENT);
  // Now all have embeddings; only-missing should find none.
  const stat = await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit']), SILENT);
  assert.strictEqual(stat.total, 0);
});

test('--all re-embeds rows that already have embeddings', async () => {
  const db = makeDb();
  seedKnowledge(db, 2);
  await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit']), SILENT);
  const stat = await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit', '--all']), SILENT);
  assert.strictEqual(stat.total, 2);
  assert.strictEqual(stat.embedded, 2);
});

test('theological_memory is skipped without --allow-theological', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO theological_memory (id,category,reference_key,body,source) VALUES (?,?,?,?,?)')
    .run('t1', 'saint', 'Saint.Test', 'a holy life', 'sample');
  const stat = await backfillTable(db, 'theological_memory', liveEmbed, parseArgs(['--commit']), SILENT);
  assert.strictEqual(stat.skipped, 'immutable_locked');
});

test('theological_memory re-embeds with --allow-theological and RESTORES triggers', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO theological_memory (id,category,reference_key,body,source) VALUES (?,?,?,?,?)')
    .run('t1', 'saint', 'Saint.Test', 'a holy life', 'sample');
  const stat = await backfillTable(
    db, 'theological_memory', liveEmbed,
    parseArgs(['--commit', '--allow-theological']), SILENT,
  );
  assert.strictEqual(stat.embedded, 1);
  // embedding written
  const row = db.prepare('SELECT embedding FROM theological_memory WHERE id = ?').get('t1');
  assert.ok(row.embedding, 'embedding should be written');
  // immutability trigger restored: a normal UPDATE must now ABORT again
  assert.throws(
    () => db.prepare('UPDATE theological_memory SET body = ? WHERE id = ?').run('tampered', 't1'),
    /immutable after seeding/,
    'no_update trigger must be restored after backfill',
  );
});

test('triggers are restored even when embedding throws mid-run', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO theological_memory (id,category,reference_key,body,source) VALUES (?,?,?,?,?)')
    .run('t1', 'saint', 'Saint.Test', 'a holy life', 'sample');
  const throwingEmbed = async () => { throw new Error('inference down'); };
  await assert.rejects(
    () => backfillTable(db, 'theological_memory', throwingEmbed, parseArgs(['--commit', '--allow-theological']), SILENT),
  );
  // Even though it threw, the immutability trigger must be back.
  assert.throws(
    () => db.prepare('UPDATE theological_memory SET body = ? WHERE id = ?').run('x', 't1'),
    /immutable after seeding/,
  );
});

test('failed embeds are counted, not written', async () => {
  const db = makeDb();
  seedKnowledge(db, 2);
  const failEmbed = async () => null; // simulates embed failure
  const stat = await backfillTable(db, 'knowledge_memory', failEmbed, parseArgs(['--commit']), SILENT);
  assert.strictEqual(stat.failed, 2);
  assert.strictEqual(stat.embedded, 0);
  const withVec = db.prepare('SELECT COUNT(*) c FROM knowledge_memory WHERE embedding IS NOT NULL').get().c;
  assert.strictEqual(withVec, 0);
});

test('batching commits in chunks without losing rows', async () => {
  const db = makeDb();
  seedKnowledge(db, 7);
  const stat = await backfillTable(db, 'knowledge_memory', liveEmbed, parseArgs(['--commit', '--batch=3']), SILENT);
  assert.strictEqual(stat.embedded, 7);
  const withVec = db.prepare('SELECT COUNT(*) c FROM knowledge_memory WHERE embedding IS NOT NULL').get().c;
  assert.strictEqual(withVec, 7);
});
