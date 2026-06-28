#!/usr/bin/env node
'use strict';

/**
 * backfill-embeddings.js — re-embed existing memory rows with the live embedder.
 *
 * WHY: rows seeded before live embeddings existed have NULL `embedding` blobs.
 * Once LiteLLM/Ollama is live on om-dev (.254), this re-embeds them so semantic
 * RAG retrieval works against stored vectors.
 *
 * SAFETY / DOCTRINE:
 *   - Embeddings come ONLY through BrainAIClient.embed() → LAN-only circuit
 *     breaker + redaction-before-send. The script never opens its own socket to
 *     an inference host, so the LAN-only guarantee and secret redaction hold.
 *   - DRY-RUN by default. Nothing is written unless --commit is passed.
 *   - `theological_memory` is immutable (BEFORE UPDATE/DELETE triggers ABORT).
 *     Re-embedding it is gated behind --allow-theological. When permitted, BOTH
 *     triggers are dropped and recreated inside a try/finally so the
 *     immutability contract is ALWAYS restored, even if embedding throws.
 *     Only the `embedding` column is touched — body/text is never modified.
 *
 * USAGE:
 *   node scripts/backfill-embeddings.js [options]
 *
 * OPTIONS:
 *   --dry-run             Preview only; write nothing. (DEFAULT)
 *   --commit              Actually write embeddings.
 *   --tables=a,b          Comma list (default: knowledge_memory).
 *                         Allowed: knowledge_memory, theological_memory.
 *   --allow-theological   Permit re-embedding the immutable theological_memory.
 *   --only-missing        Only rows with embedding IS NULL. (DEFAULT)
 *   --all                 Re-embed every row, overwriting existing vectors.
 *   --batch=N             Commit every N rows (default 50).
 *   --db=PATH             Override DB path (else BRAIN_DB_PATH / DB_PATH /
 *                         /var/lib/om-brain/brain.db).
 *   --no-live             Use the deterministic embedder (local testing).
 *   --help
 *
 * EXIT: 0 ok · 1 usage/setup error · 2 partial (some rows failed to embed).
 */

const { encodeVector } = require('../src/memory/vectorStore');
const { deterministicEmbed } = require('../src/memory/ragRetriever');

const ALLOWED_TABLES = {
  knowledge_memory: { textCols: ['title', 'body'], immutable: false },
  theological_memory: { textCols: ['title', 'body'], immutable: true },
};

const THEO_TRIGGERS = [
  {
    name: 'theological_memory_no_update',
    sql: `CREATE TRIGGER IF NOT EXISTS theological_memory_no_update
BEFORE UPDATE ON theological_memory
BEGIN
  SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: UPDATE forbidden');
END;`,
  },
  {
    name: 'theological_memory_no_delete',
    sql: `CREATE TRIGGER IF NOT EXISTS theological_memory_no_delete
BEFORE DELETE ON theological_memory
BEGIN
  SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: DELETE forbidden');
END;`,
  },
];

function parseArgs(argv) {
  const a = {
    commit: false,
    tables: ['knowledge_memory'],
    allowTheological: false,
    mode: 'only-missing',
    batch: 50,
    db: null,
    live: true,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg === '--commit') a.commit = true;
    else if (arg === '--dry-run') a.commit = false;
    else if (arg === '--allow-theological') a.allowTheological = true;
    else if (arg === '--only-missing') a.mode = 'only-missing';
    else if (arg === '--all') a.mode = 'all';
    else if (arg === '--no-live') a.live = false;
    else if (arg.startsWith('--tables=')) a.tables = arg.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--batch=')) a.batch = Math.max(1, parseInt(arg.slice(8), 10) || 50);
    else if (arg.startsWith('--db=')) a.db = arg.slice(5);
    else throw new Error(`unknown option: ${arg}`);
  }
  return a;
}

function buildEmbedder(opts) {
  // async (text) => number[] | null. Live path goes through BrainAIClient.embed
  // (breaker + redaction). Deterministic path is for --no-live / tests.
  if (!opts.live) {
    return async (text) => deterministicEmbed(text, 256);
  }
  // eslint-disable-next-line global-require
  const { BrainAIClient } = require('../src/ai/client');
  const ai = new BrainAIClient();
  return async (text) => {
    const res = await ai.embed(text);
    if (res && res.ok && Array.isArray(res.vector) && res.vector.length) return res.vector;
    return null;
  };
}

function rowText(row, textCols) {
  return textCols.map((c) => (row[c] == null ? '' : String(row[c]))).join('\n').trim();
}

/**
 * Backfill one table. Returns { table, total, embedded, failed, skipped }.
 * `db` is a better-sqlite3-like handle (prepare/exec).
 */
async function backfillTable(db, table, embed, opts, log = console) {
  const meta = ALLOWED_TABLES[table];
  if (!meta) throw new Error(`table not allowed: ${table}`);

  if (meta.immutable && !opts.allowTheological) {
    log.warn(`[skip] ${table} is immutable; pass --allow-theological to re-embed it.`);
    return { table, total: 0, embedded: 0, failed: 0, skipped: 'immutable_locked' };
  }

  const where = opts.mode === 'only-missing' ? 'WHERE embedding IS NULL' : '';
  const rows = db.prepare(`SELECT * FROM ${table} ${where}`).all();
  const stat = { table, total: rows.length, embedded: 0, failed: 0, skipped: 0 };

  if (rows.length === 0) {
    log.info(`[${table}] no rows to embed (${opts.mode}).`);
    return stat;
  }

  // Drop immutability triggers only while committing to the immutable table.
  const droppedTriggers = [];
  if (meta.immutable && opts.commit) {
    for (const t of THEO_TRIGGERS) {
      db.exec(`DROP TRIGGER IF EXISTS ${t.name};`);
      droppedTriggers.push(t);
    }
  }

  const update = opts.commit ? db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`) : null;

  try {
    let batchOpen = false;
    const begin = () => { if (opts.commit) { db.exec('BEGIN'); batchOpen = true; } };
    const commit = () => { if (opts.commit && batchOpen) { db.exec('COMMIT'); batchOpen = false; } };

    begin();
    let inBatch = 0;
    for (const row of rows) {
      const text = rowText(row, meta.textCols);
      if (!text) { stat.skipped += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const vec = await embed(text);
      if (!vec) {
        stat.failed += 1;
        log.warn(`[${table}] embed failed for id=${row.id} (skipped)`);
        continue;
      }
      if (opts.commit) {
        update.run(encodeVector(vec), row.id);
        inBatch += 1;
        if (inBatch >= opts.batch) { commit(); begin(); inBatch = 0; }
      }
      stat.embedded += 1;
    }
    commit();
  } finally {
    // ALWAYS restore the immutability triggers, even on error.
    if (meta.immutable && opts.commit) {
      for (const t of droppedTriggers) db.exec(t.sql);
    }
  }

  log.info(
    `[${table}] total=${stat.total} embedded=${stat.embedded} failed=${stat.failed} skipped=${stat.skipped}` +
    (opts.commit ? '' : ' (dry-run: no writes)'),
  );
  return stat;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (opts.help) {
    const fs = require('fs');
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 50).join('\n'));
    process.exit(0);
  }

  for (const t of opts.tables) {
    if (!ALLOWED_TABLES[t]) {
      console.error(`table not allowed: ${t} (allowed: ${Object.keys(ALLOWED_TABLES).join(', ')})`);
      process.exit(1);
    }
  }

  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  const dbPath = opts.db || process.env.BRAIN_DB_PATH || process.env.DB_PATH || '/var/lib/om-brain/brain.db';
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.error(`cannot open db at ${dbPath}: ${e.message}`);
    process.exit(1);
  }

  const embed = buildEmbedder(opts);
  console.log(
    `backfill-embeddings: db=${dbPath} tables=${opts.tables.join(',')} mode=${opts.mode} ` +
    `${opts.commit ? 'COMMIT' : 'DRY-RUN'} ${opts.live ? 'live-embedder' : 'deterministic-embedder'}`,
  );

  let failedTotal = 0;
  for (const table of opts.tables) {
    // eslint-disable-next-line no-await-in-loop
    const stat = await backfillTable(db, table, embed, opts);
    if (typeof stat.failed === 'number') failedTotal += stat.failed;
  }
  db.close();
  process.exit(failedTotal > 0 ? 2 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, backfillTable, buildEmbedder, rowText, ALLOWED_TABLES, THEO_TRIGGERS };
