'use strict';

/**
 * init-db — create the memory schema and seed:
 *   - Doctrine Memory (from local doctrine text, chunked by RULE blocks)
 *   - System-Truth Memory (from systemTruthSeed)
 *
 * Embeddings are NOT generated here by default (local inference may be offline
 * in a build sandbox). The schema supports embeddings; they can be backfilled
 * later. RAG falls back to keyword recall when embeddings are absent.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { MemoryDB } = require('../src/memory/db');
const systemTruthSeed = require('../src/memory/systemTruthSeed');

function chunkDoctrine(text) {
  // Split on "## RULE <key>" headings.
  const chunks = [];
  const re = /^##\s+RULE\s+([^\n]+)\n([\s\S]*?)(?=^##\s+RULE\s+|\Z)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ruleKey = m[1].trim();
    const body = m[2].trim();
    const title = body.split('\n')[0].slice(0, 120);
    chunks.push({ rule_key: ruleKey, title, body, source_ref: 'OM-DOCTRINE-0001 (Brain-loaded)' });
  }
  return chunks;
}

function main() {
  const db = new MemoryDB({
    dbPath: config.memory.dbPath,
    embeddingDim: config.memory.embeddingDim,
  }).init();

  process.stdout.write(`[init-db] memory backend: ${db.backendName()}\n`);

  // Doctrine memory
  const doctrinePath = path.resolve(process.cwd(), config.memory.doctrinePath);
  let doctrineCount = 0;
  if (fs.existsSync(doctrinePath)) {
    const text = fs.readFileSync(doctrinePath, 'utf8');
    for (const c of chunkDoctrine(text)) {
      db.insertDoctrine(c);
      doctrineCount++;
    }
  } else {
    process.stdout.write(`[init-db] WARNING: doctrine file not found at ${doctrinePath}\n`);
  }

  // System-truth memory
  let truthCount = 0;
  for (const f of systemTruthSeed) {
    db.upsertSystemTruth(f);
    truthCount++;
  }

  db.close();
  process.stdout.write(
    `[init-db] seeded ${doctrineCount} doctrine rule(s) and ${truthCount} system-truth fact(s).\n`,
  );
  process.stdout.write('[init-db] done.\n');
}

main();
