'use strict';

/**
 * One-time / periodic backfill: embed knowledge_memory + theological_memory rows
 * via local Ollama (nomic-embed-text). Run on om-dev (.254) after deploy.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js [--force] [--table=theological|knowledge|all]
 *
 * --force  Re-embed rows that already have an embedding column set.
 */

const Database = require('better-sqlite3');
const http = require('http');

const DB_PATH = process.env.BRAIN_DB_PATH || process.env.DB_PATH || '/var/lib/om-brain/brain.db';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const MODEL = process.env.BRAIN_LLM_EMBEDDING_MODEL || 'nomic-embed-text';
const force = process.argv.includes('--force');
const tableArg = process.argv.find((a) => a.startsWith('--table='));
const tableFilter = tableArg ? tableArg.split('=')[1] : 'all';

function fetchEmbedding(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, prompt: text });
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/embeddings',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.embedding) return reject(new Error('no embedding in response'));
            resolve(parsed.embedding);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function encodeFloat32(arr) {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i += 1) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

async function backfillTable(db, table, textCol) {
  const where = force ? '1=1' : 'embedding IS NULL';
  const rows = db.prepare(`SELECT id, ${textCol} AS text FROM ${table} WHERE ${where}`).all();
  console.log(`[${table}] embedding ${rows.length} rows (force=${force})...`);
  const update = db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`);
  let done = 0;
  let lastDim = 0;
  for (const row of rows) {
    const text = String(row.text || '').slice(0, 2000);
    if (!text) continue;
    // eslint-disable-next-line no-await-in-loop
    const vec = await fetchEmbedding(text);
    lastDim = vec.length;
    update.run(encodeFloat32(vec), row.id);
    done += 1;
    if (done % 5 === 0) console.log(`  ${table}: ${done}/${rows.length}`);
  }
  console.log(`[${table}] done: ${done} rows embedded (dim=${lastDim || '?'})`);
  return done;
}

async function main() {
  const db = new Database(DB_PATH);
  db.exec('DROP TRIGGER IF EXISTS theological_memory_no_update');
  let total = 0;
  if (tableFilter === 'all' || tableFilter === 'theological') {
    total += await backfillTable(db, 'theological_memory', 'body');
  }
  if (tableFilter === 'all' || tableFilter === 'knowledge') {
    total += await backfillTable(db, 'knowledge_memory', 'body');
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS theological_memory_no_update
    BEFORE UPDATE ON theological_memory
    BEGIN
      SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: UPDATE forbidden');
    END;
  `);
  console.log(`Backfill complete: ${total} total rows.`);
}

main().catch((e) => {
  console.error('backfill-embeddings failed:', e.message);
  process.exit(1);
});
