'use strict';

/**
 * Confirms embed-theology.js no longer carries a direct-Ollama implementation and
 * delegates to the hardened backfill module (doctrine parity).
 * Run: cd om-brain && npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { backfillTable, parseArgs, THEO_TRIGGERS } = require('../scripts/backfill-embeddings');
const { deterministicEmbed } = require('../src/memory/ragRetriever');

const SILENT = { info() {}, warn() {} };
const SRC = fs.readFileSync(path.join(__dirname, '../scripts/theology/embed-theology.js'), 'utf8');

test('embed-theology no longer opens a raw Ollama socket', () => {
  assert.ok(!/http\.request/.test(SRC), 'must not use http.request');
  assert.ok(!/api\/embeddings/.test(SRC), 'must not hit /api/embeddings directly');
  assert.ok(/backfill-embeddings/.test(SRC), 'must delegate to the hardened backfill module');
});

test('delegated theology embedding writes vectors and restores immutability', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE theological_memory (
    id TEXT PRIMARY KEY, category TEXT, reference_key TEXT, title TEXT,
    body TEXT, source TEXT, embedding BLOB
  );`);
  for (const t of THEO_TRIGGERS) db.exec(t.sql);
  db.prepare('INSERT INTO theological_memory (id,category,reference_key,body,source) VALUES (?,?,?,?,?)')
    .run('t1', 'saint', 'Saint.Test', 'a holy life of prayer', 'sample');

  const embed = async (text) => deterministicEmbed(text, 256);
  const opts = parseArgs(['--commit', '--tables=theological_memory', '--allow-theological']);
  const stat = await backfillTable(db, 'theological_memory', embed, opts, SILENT);

  assert.strictEqual(stat.embedded, 1);
  assert.throws(
    () => db.prepare('UPDATE theological_memory SET body = ? WHERE id = ?').run('x', 't1'),
    /immutable after seeding/,
    'immutability trigger must be restored',
  );
});
