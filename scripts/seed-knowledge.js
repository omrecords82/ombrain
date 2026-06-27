'use strict';
/**
 * seed-knowledge — seed knowledge_memory from Markdown files.
 *
 * Usage:
 *   node scripts/seed-knowledge.js [--file <path>] [--slug <slug>] [--category <cat>]
 *
 * Defaults (no flags):
 *   Seeds the canonical auth-configuration.md document from the project root
 *   (../../auth-configuration.md relative to this script, or the path in
 *   BRAIN_AUTH_CONFIG_PATH env var).
 *
 * Examples:
 *   node scripts/seed-knowledge.js
 *   node scripts/seed-knowledge.js --file /opt/om-brain/docs/auth-configuration.md
 *   node scripts/seed-knowledge.js --file ./docs/my-doc.md --slug my-doc --category ops
 *
 * The script is idempotent — running it again updates the existing document
 * (upsert by slug).
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config }   = require('../src/config');
const { MemoryDB } = require('../src/memory/db');

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file'     && argv[i + 1]) { flags.file     = argv[++i]; }
  if (argv[i] === '--slug'     && argv[i + 1]) { flags.slug     = argv[++i]; }
  if (argv[i] === '--category' && argv[i + 1]) { flags.category = argv[++i]; }
  if (argv[i] === '--title'    && argv[i + 1]) { flags.title    = argv[++i]; }
  if (argv[i] === '--source'   && argv[i + 1]) { flags.source   = argv[++i]; }
}

// ---------------------------------------------------------------------------
// Resolve file path
// ---------------------------------------------------------------------------
const DEFAULT_FILE = process.env.BRAIN_AUTH_CONFIG_PATH
  || path.resolve(__dirname, '../../docs/operations/auth-configuration.md');

const filePath = flags.file
  ? path.resolve(process.cwd(), flags.file)
  : DEFAULT_FILE;

if (!fs.existsSync(filePath)) {
  console.error(`[seed-knowledge] ERROR: file not found: ${filePath}`);
  console.error('  Set BRAIN_AUTH_CONFIG_PATH or pass --file <path>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Derive metadata from filename / first heading
// ---------------------------------------------------------------------------
const rawBody = fs.readFileSync(filePath, 'utf8');

function deriveTitle(body, fallback) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function deriveSlug(filePath) {
  return path.basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const slug     = flags.slug     || deriveSlug(filePath);
const title    = flags.title    || deriveTitle(rawBody, slug);
const category = flags.category || 'ops';
const sourceRef = flags.source  || `file:${path.basename(filePath)}`;

// ---------------------------------------------------------------------------
// Open DB and upsert
// ---------------------------------------------------------------------------
const db = new MemoryDB({
  dbPath:       config.memory.dbPath,
  embeddingDim: config.memory.embeddingDim,
}).init();

const id = crypto.randomUUID();

db.upsertKnowledge({
  id,
  slug,
  title,
  body:       rawBody,
  category,
  tags_json:  JSON.stringify(['auth', 'configuration', 'platform']),
  source_ref: sourceRef,
  confidence: 1.0,
});

const saved = db.getKnowledgeBySlug(slug);
db.close();

if (saved) {
  console.log(`[seed-knowledge] ✓ Upserted knowledge document`);
  console.log(`  slug     : ${saved.slug}`);
  console.log(`  title    : ${saved.title}`);
  console.log(`  category : ${saved.category}`);
  console.log(`  chars    : ${rawBody.length}`);
  console.log(`  source   : ${sourceRef}`);
  console.log(`  updated  : ${saved.updated_at}`);
} else {
  console.error('[seed-knowledge] ERROR: upsert appeared to succeed but document not found on read-back');
  process.exit(1);
}
