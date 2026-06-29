'use strict';

/**
 * scan-doc-registry — filesystem scan → doc_registry table + DOC-SNAPSHOT.md
 *
 * Reads om-brain/inventory/doc-roots.json and doc-structure.json.
 * Default: dry-run (snapshot only). Pass --commit to persist to brain.db.
 *
 * Usage:
 *   node scripts/scan-doc-registry.js [--commit] [--roots <path>] [--out <path>]
 *
 * Recommended run host: om-prod01 (.239) where doc roots live.
 */

const fs = require('fs');
const path = require('path');
const { MemoryDB } = require('../src/memory/db');
const { config } = require('../src/config');
const { runScan, DEFAULT_ROOTS, DEFAULT_SNAPSHOT } = require('../src/docRegistry');

const ROOT = path.resolve(__dirname, '..');

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    commit: false,
    rootsPath: DEFAULT_ROOTS,
    structurePath: path.join(ROOT, 'inventory', 'doc-structure.json'),
    outPath: DEFAULT_SNAPSHOT,
    dbPath: config.memory.dbPath,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') opts.commit = true;
    else if (argv[i] === '--roots' && argv[i + 1]) opts.rootsPath = argv[++i];
    else if (argv[i] === '--structure' && argv[i + 1]) opts.structurePath = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) opts.outPath = argv[++i];
    else if (argv[i] === '--db' && argv[i + 1]) opts.dbPath = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(
        'Usage: node scripts/scan-doc-registry.js [--commit] [--roots <path>] [--out <path>]\n',
      );
      process.exit(0);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.rootsPath)) {
    process.stderr.write(`[scan-doc-registry] roots file not found: ${opts.rootsPath}\n`);
    process.exit(1);
  }

  let db = null;
  if (opts.commit) {
    db = new MemoryDB({ dbPath: opts.dbPath, embeddingDim: config.memory.embeddingDim }).init();
  }

  const result = runScan(db, opts);
  if (db) db.close();

  process.stdout.write(
    `[scan-doc-registry] wrote ${result.snapshotPath} (${result.stats.total} paths, commit=${opts.commit})\n`,
  );
}

main();
