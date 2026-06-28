#!/usr/bin/env node
'use strict';

/**
 * embed-theology.js — embed theological_memory rows.
 *
 * DEPRECATED as a standalone implementation. It now delegates to the hardened,
 * breaker-guarded backfill module (scripts/backfill-embeddings.js) so there is a
 * single embedding code path with consistent doctrine guarantees:
 *   - Embeddings go through BrainAIClient.embed() (LAN-only circuit breaker +
 *     redaction-before-send) — never a raw direct Ollama socket.
 *   - theological_memory immutability triggers (no_update AND no_delete) are
 *     dropped and recreated inside try/finally, so immutability is always
 *     restored even if embedding throws mid-run.
 *
 * Behaviour preserved: embeds theological_memory rows whose embedding IS NULL.
 *
 * USAGE:
 *   node scripts/theology/embed-theology.js [--commit] [--all] [--no-live] [--db=PATH]
 *
 * By default this is a DRY-RUN (prints what would change). Pass --commit to write.
 * (The previous version always wrote immediately and called Ollama directly.)
 */

const { backfillTable, buildEmbedder, parseArgs } = require('../backfill-embeddings');

async function main() {
  // Reuse the backfill arg parser, but force this script's table scope and the
  // explicit theological opt-in so callers don't have to remember the flag.
  const passthrough = process.argv.slice(2).filter(
    (a) => a === '--commit' || a === '--dry-run' || a === '--all' || a === '--only-missing'
      || a === '--no-live' || a.startsWith('--batch=') || a.startsWith('--db='),
  );
  const opts = parseArgs([...passthrough, '--tables=theological_memory', '--allow-theological']);

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
    `embed-theology: db=${dbPath} mode=${opts.mode} ${opts.commit ? 'COMMIT' : 'DRY-RUN'} ` +
    `${opts.live ? 'live-embedder' : 'deterministic-embedder'}`,
  );

  const stat = await backfillTable(db, 'theological_memory', embed, opts);
  db.close();
  console.log(`embed-theology complete: embedded=${stat.embedded} failed=${stat.failed}`);
  process.exit(stat.failed > 0 ? 2 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error('embed-theology failed:', e.message); process.exit(1); });
}

module.exports = { main };
