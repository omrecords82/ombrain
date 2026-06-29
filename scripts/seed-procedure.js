'use strict';
/**
 * seed-procedure — seed procedure_memory from a Markdown file.
 *
 * Usage:
 *   node scripts/seed-procedure.js --file <path> --slug <slug> [options]
 *
 * Bug tracker (defaults):
 *   node scripts/seed-procedure.js
 *
 * Options:
 *   --file <path>        Markdown source (default: docs/om-brain/skills/bug-tracker.md)
 *   --slug <slug>        Procedure slug (default: derived from filename)
 *   --title <title>      Override title (default: first # heading)
 *   --intent-key <key>   intent_key column (default: slug)
 *   --mode <mode>        knowledge | technical | ops (default: ops for bug-tracker, knowledge otherwise)
 *   --risk <level>       low | medium | high | destructive (default: low)
 *   --approved           Mark approved=1 (default for bug-tracker seed)
 *   --draft              Mark approved=0
 *   --confidence <0-1>   Default 1.0 for imported operator procedures
 *
 * Idempotent — re-run updates by slug (stable id on repeat).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const prodEnv = '/etc/om-brain/om-brain.env';
if (!process.env.BRAIN_DB_PATH && fs.existsSync(prodEnv)) {
  for (const line of fs.readFileSync(prodEnv, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { config } = require('../src/config');
const { MemoryDB } = require('../src/memory/db');

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file' && argv[i + 1]) flags.file = argv[++i];
  else if (argv[i] === '--slug' && argv[i + 1]) flags.slug = argv[++i];
  else if (argv[i] === '--title' && argv[i + 1]) flags.title = argv[++i];
  else if (argv[i] === '--intent-key' && argv[i + 1]) flags.intentKey = argv[++i];
  else if (argv[i] === '--mode' && argv[i + 1]) flags.mode = argv[++i];
  else if (argv[i] === '--risk' && argv[i + 1]) flags.risk = argv[++i];
  else if (argv[i] === '--confidence' && argv[i + 1]) flags.confidence = Number(argv[++i]);
  else if (argv[i] === '--approved') flags.approved = true;
  else if (argv[i] === '--draft') flags.approved = false;
}

const DEFAULT_FILE = path.resolve(__dirname, '../../docs/om-brain/skills/bug-tracker.md');
const filePath = flags.file ? path.resolve(process.cwd(), flags.file) : DEFAULT_FILE;

if (!fs.existsSync(filePath)) {
  console.error(`[seed-procedure] ERROR: file not found: ${filePath}`);
  process.exit(1);
}

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

const rawBody = fs.readFileSync(filePath, 'utf8');
const slug = flags.slug || deriveSlug(filePath);
const title = flags.title || deriveTitle(rawBody, slug);
const intentKey = flags.intentKey || slug;
const mode = flags.mode || (slug === 'bug-tracker' ? 'ops' : 'knowledge');
const riskLevel = flags.risk || 'low';
const approved = flags.approved != null ? flags.approved : slug === 'bug-tracker';
const confidence = flags.confidence != null ? flags.confidence : (approved ? 1.0 : 0.0);

const triggerExamples = slug === 'bug-tracker'
  ? [
      'track this bug',
      'triage regression',
      'SESSION_TERMINATED',
      'login failure after revoke',
      'log bug om omai',
      'verify fix deployed',
      'bug tracker',
    ]
  : [slug.replace(/-/g, ' ')];

const commands = slug === 'bug-tracker'
  ? [
      { cmd: 'curl -s http://127.0.0.1:3001/api/system/health', description: 'OM backend health', expected_output: 'ok JSON' },
      { cmd: 'curl -s http://127.0.0.1:7060/api/health', description: 'OMAI health', expected_output: 'ok JSON' },
      { cmd: 'sudo journalctl -u orthodox-backend -n 40 --no-pager', description: 'Recent OM backend logs' },
      { cmd: 'rg -l "SESSION_TERMINATED|sessionTracker" /var/www/orthodoxmetrics/prod/server/src', description: 'Locate session middleware' },
    ]
  : [];

const validationSteps = slug === 'bug-tracker'
  ? [
      'Repro steps no longer fail',
      'Health curls return ok',
      'GAP-CLOSURE-REPORT row added if fleet-wide fix',
      'Deploy script used (not manual restart)',
    ]
  : ['Procedure steps completed'];

const db = new MemoryDB({
  dbPath: config.memory.dbPath,
  embeddingDim: config.memory.embeddingDim,
}).init();

const existing = db.getProcedureBySlug(slug);
const id = existing ? existing.id : crypto.randomUUID();

db.upsertProcedure({
  id,
  slug,
  title,
  intent_key: intentKey,
  mode,
  trigger_examples: JSON.stringify(triggerExamples),
  procedure_body: rawBody,
  commands_json: commands.length ? JSON.stringify(commands) : null,
  risk_level: riskLevel,
  validation_steps: JSON.stringify(validationSteps),
  source_type: 'imported',
  confidence,
  approved: approved ? 1 : 0,
  approved_by: approved ? 'seed-procedure' : null,
  approved_at: approved ? new Date().toISOString() : null,
  usage_count: existing ? existing.usage_count || 0 : 0,
});

const saved = db.getProcedureBySlug(slug);
db.close();

if (saved) {
  console.log('[seed-procedure] ✓ Upserted procedure');
  console.log(`  slug      : ${saved.slug}`);
  console.log(`  title     : ${saved.title}`);
  console.log(`  mode      : ${saved.mode}`);
  console.log(`  approved  : ${saved.approved ? 'yes' : 'no'}`);
  console.log(`  chars     : ${rawBody.length}`);
  console.log(`  source    : file:${path.basename(filePath)}`);
} else {
  console.error('[seed-procedure] ERROR: upsert succeeded but read-back failed');
  process.exit(1);
}
