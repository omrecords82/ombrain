'use strict';

const Database = require('better-sqlite3');
const http = require('http');

const DB_PATH = process.env.BRAIN_DB_PATH || process.env.DB_PATH || '/var/lib/om-brain/brain.db';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const MODEL = process.env.BRAIN_LLM_EMBEDDING_MODEL || 'nomic-embed-text';

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

async function main() {
  const db = new Database(DB_PATH);
  // Immutability triggers block UPDATE; lift temporarily for embedding pass only.
  db.exec('DROP TRIGGER IF EXISTS theological_memory_no_update');
  const rows = db.prepare('SELECT id, body FROM theological_memory WHERE embedding IS NULL').all();
  console.log(`Generating embeddings for ${rows.length} theological_memory rows...`);
  let done = 0;
  const update = db.prepare('UPDATE theological_memory SET embedding = ? WHERE id = ?');
  for (const row of rows) {
    const vec = await fetchEmbedding(row.body.slice(0, 2000));
    update.run(encodeFloat32(vec), row.id);
    done += 1;
    if (done % 5 === 0) console.log(`  embedded ${done}/${rows.length}`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS theological_memory_no_update
    BEFORE UPDATE ON theological_memory
    BEGIN
      SELECT RAISE(ABORT, 'theological_memory is immutable after seeding: UPDATE forbidden');
    END;
  `);
  console.log(`Embedding generation complete: ${done} rows.`);
}

main().catch((e) => {
  console.error('embed-theology failed:', e.message);
  process.exit(1);
});
