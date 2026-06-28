#!/usr/bin/env node
'use strict';

/**
 * om-brain CLI (Phase 7 + Phase 2 extended memory)
 *
 * Local testing entry point for all om-brain subsystems.
 *
 * Usage:
 *   node bin/om-brain-cli.js <command> [args...]
 *
 * Commands:
 *   calendar pascha <year>                    Print Pascha date for a year
 *   calendar feasts <year>                    List all moveable feasts for a year
 *   calendar fasting <YYYY-MM-DD>             Get fasting rule for a date
 *   doctrine get <slug>                       Get a doctrine entry by slug
 *   doctrine search <query>                   Search doctrine by keyword
 *   doctrine list                             List all doctrine slugs
 *   scripture parse <reference>               Parse a scripture reference
 *   scripture extract <text>                  Extract all references from text
 *   church text <query>                       Search churches by text
 *   church nearby <lat> <lng>                 Search churches near coordinates
 *   mode classify <query>                     Classify a query into a mode
 *   mode list                                 List all available modes
 *   procedures list [--approved] [--draft]    List all procedures
 *   procedures search <query>                 Search procedures by keyword
 *   procedures show <slug>                    Show full procedure detail
 *   procedures approve <slug> [--by <who>]    Approve a draft procedure
 *   procedures reject  <slug> [--by <who>]    Reject a draft procedure
 *   procedures revise  <slug>                 Mark procedure as needing revision (reject + note)
 *   knowledge list [--category <cat>]         List knowledge documents
 *   knowledge search <query>                  Search knowledge by keyword
 *   knowledge show <slug>                     Show full knowledge document
 *   tasks list [--status open|snoozed|done]   List tasks
 *   tasks show <id>                           Show a task
 *   help                                      Show this help
 */

const path = require('path');
const root  = path.resolve(__dirname, '..');

// Lazy-load subsystems to avoid startup cost for unused commands
function loadCalendar()    { return require(path.join(root, 'src/calendar')); }
function loadTheology()    { return require(path.join(root, 'src/theology')); }
function loadChurchFinder(){ return require(path.join(root, 'src/churchFinder')); }
function loadModes()       { return require(path.join(root, 'src/modes')); }
function loadDB() {
  const { config }   = require(path.join(root, 'src/config'));
  const { MemoryDB } = require(path.join(root, 'src/memory/db'));
  return new MemoryDB({ dbPath: config.memory.dbPath, embeddingDim: config.memory.embeddingDim }).init();
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJSON(obj) { console.log(JSON.stringify(obj, null, 2)); }
function printError(msg) { console.error(`\x1b[31mError:\x1b[0m ${msg}`); process.exit(1); }

/**
 * Render the execution source footer from a /diagnose response object.
 * Called by any command that surfaces a diagnose result.
 */
function printExecutionSourceFooter(result) {
  const es = result && result.execution_source;
  if (!es) return;
  console.log('\n\x1b[2m─── Execution Source ───────────────────────────────────────\x1b[0m');
  console.log(`  Local deterministic engine : \x1b[${es.local_deterministic_engine ? '32myes' : '31mno'}\x1b[0m`);
  console.log(`  Local memory used          : \x1b[${es.local_memory_used ? '32myes' : '33mno'}\x1b[0m${es.local_memory_source ? ' (' + es.local_memory_source + ')' : ''}`);
  console.log(`  LLM used                   : \x1b[${es.llm_used ? '33myes' : '32mno'}\x1b[0m${es.llm_skipped_reason ? ' (skipped: ' + es.llm_skipped_reason + ')' : ''}`);
  console.log(`  Procedure learned          : \x1b[${es.procedure_learned ? '33myes' : '32mno'}\x1b[0m${es.procedure_slug ? ' (' + es.procedure_slug + ')' : ''}`);
  console.log(`  Approval required          : \x1b[${es.procedure_approval_required ? '31myes' : '32mno'}\x1b[0m`);
  console.log('\x1b[2m────────────────────────────────────────────────────────────\x1b[0m');
}

function printHelp() {
  console.log(`
\x1b[1mom-brain CLI\x1b[0m — Orthodox Mind AI local test tool

\x1b[33mCalendar:\x1b[0m
  calendar pascha <year>              Pascha date (Gregorian + Julian)
  calendar feasts <year>              All moveable feasts for a year
  calendar fasting <YYYY-MM-DD>       Fasting rule for a specific date

\x1b[33mDoctrine:\x1b[0m
  doctrine get <slug>                 Doctrine entry by slug
  doctrine search <query...>          Fuzzy keyword search
  doctrine list                       All 16 doctrine slugs

\x1b[33mScripture:\x1b[0m
  scripture parse <reference>         Parse a scripture reference
  scripture extract "<text>"          Extract all refs from text

\x1b[33mChurch Finder:\x1b[0m
  church text <query...>              Text search for Orthodox churches
  church nearby <lat> <lng>           Nearby search by coordinates

\x1b[33mModes:\x1b[0m
  mode classify <query...>            Classify query into a mode
  mode list                           List all modes

\x1b[33mAsk (unified query):\x1b[0m
  ask <query...>                      Classify + route a query through the pipeline
  ask --mode <mode> <query...>        Force a specific mode (calendar|study|prayer|church|pastoral|ops|general)
  pastoral <query...>                 Pastoral / spiritual-counsel guidance (informational)
  ops <query...>                      Operational / fleet-health query (read-only)

\x1b[33mProcedure Memory:\x1b[0m
  procedures list [--approved] [--draft]   List procedures (default: all)
  procedures search <query...>             Full-text search procedures
  procedures show <slug>                   Full procedure detail
  procedures approve <slug> [--by <who>]   Approve a draft procedure
  procedures reject  <slug> [--by <who>]   Reject a draft procedure
  procedures revise  <slug> [--by <who>]   Mark for revision (reject + revision note)

\x1b[33mKnowledge Memory:\x1b[0m
  knowledge list [--category <cat>]   List knowledge documents
  knowledge search <query...>         Full-text search knowledge
  knowledge show <slug>               Full document body

\x1b[33mTask Memory:\x1b[0m
  tasks list [--status <status>]      List tasks (open|snoozed|done, default: open)
  tasks show <id>                     Full task detail

  help                                Show this help
`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdCalendar(args) {
  const { getPascha, getMoveableFeasts, getFixedFeasts } = loadCalendar();
  const { getFastingRule } = loadCalendar();
  const [sub, ...rest] = args;

  if (sub === 'pascha') {
    const year = parseInt(rest[0], 10);
    if (!year) printError('Usage: calendar pascha <year>');
    printJSON(getPascha(year));

  } else if (sub === 'feasts') {
    const year = parseInt(rest[0], 10);
    if (!year) printError('Usage: calendar feasts <year>');
    const moveable = getMoveableFeasts(year);
    const fixed    = getFixedFeasts(year);
    printJSON({ year, moveableFeasts: moveable, fixedFeasts: fixed });

  } else if (sub === 'fasting') {
    const dateStr = rest[0];
    if (!dateStr) printError('Usage: calendar fasting <YYYY-MM-DD>');
    const date = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(date.getTime())) printError(`Invalid date: ${dateStr}`);
    printJSON({ date: dateStr, ...getFastingRule(date) });

  } else {
    printError(`Unknown calendar subcommand: ${sub}. Use: pascha, feasts, fasting`);
  }
}

async function cmdDoctrine(args) {
  const { getBySlug, search, listSlugs } = loadTheology();
  const [sub, ...rest] = args;

  if (sub === 'get') {
    const slug = rest[0];
    if (!slug) printError('Usage: doctrine get <slug>');
    const entry = getBySlug(slug);
    if (!entry) printError(`No doctrine entry found for slug: ${slug}`);
    printJSON(entry);

  } else if (sub === 'search') {
    const query = rest.join(' ');
    if (!query) printError('Usage: doctrine search <query>');
    printJSON(search(query));

  } else if (sub === 'list') {
    printJSON(listSlugs());

  } else {
    printError(`Unknown doctrine subcommand: ${sub}. Use: get, search, list`);
  }
}

async function cmdScripture(args) {
  const { parseReference, extractReferences } = loadTheology();
  const [sub, ...rest] = args;

  if (sub === 'parse') {
    const ref = rest.join(' ');
    if (!ref) printError('Usage: scripture parse <reference>');
    const result = parseReference(ref);
    if (!result) printError(`Could not parse reference: "${ref}"`);
    printJSON(result);

  } else if (sub === 'extract') {
    const text = rest.join(' ');
    if (!text) printError('Usage: scripture extract "<text>"');
    printJSON(extractReferences(text));

  } else {
    printError(`Unknown scripture subcommand: ${sub}. Use: parse, extract`);
  }
}

async function cmdChurch(args) {
  const { ChurchFinder } = loadChurchFinder();
  const cf = new ChurchFinder({
    proxyBaseUrl: process.env.OMAI_PROXY_URL || 'http://192.168.1.239:7060',
    serviceToken: process.env.OMSTUDIO_SERVICE_TOKEN || '',
    timeoutMs:    8000,
    logger:       { info: () => {}, error: (e) => console.error(e) },
  });

  const [sub, ...rest] = args;

  if (sub === 'text') {
    const query = rest.join(' ');
    if (!query) printError('Usage: church text <query>');
    const result = await cf.searchByText({ query, limit: 5 });
    printJSON(result);

  } else if (sub === 'nearby') {
    const lat = parseFloat(rest[0]);
    const lng = parseFloat(rest[1]);
    if (isNaN(lat) || isNaN(lng)) printError('Usage: church nearby <lat> <lng>');
    const result = await cf.searchNearby({ lat, lng, limit: 5 });
    printJSON(result);

  } else {
    printError(`Unknown church subcommand: ${sub}. Use: text, nearby`);
  }
}

async function cmdMode(args) {
  const { classifyIntent, listModes } = loadModes();
  const [sub, ...rest] = args;

  if (sub === 'classify') {
    const query = rest.join(' ');
    if (!query) printError('Usage: mode classify <query>');
    const modeId = classifyIntent(query);
    console.log(`\x1b[32m${modeId}\x1b[0m`);

  } else if (sub === 'list') {
    const modes = listModes();
    for (const m of modes) {
      console.log(`  \x1b[33m${m.id.padEnd(12)}\x1b[0m ${m.description}`);
    }

  } else {
    printError(`Unknown mode subcommand: ${sub}. Use: classify, list`);
  }
}

// ---------------------------------------------------------------------------
// Ask / pastoral / ops commands (unified query routing)
// ---------------------------------------------------------------------------

function loadPipeline() { return require(path.join(root, 'src/queryPipeline/pipeline')); }

async function cmdAsk(args) {
  const { classifyIntent } = loadModes();
  const { handleCalendar, handleStudy, handleChurch, handlePrayer, handlePastoral, handleOps } = loadPipeline();

  // Parse optional --mode override
  let forcedMode = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) { forcedMode = args[++i]; }
    else positional.push(args[i]);
  }
  const query = positional.join(' ');
  if (!query) printError('Usage: ask [--mode <mode>] <query...>');

  const mode = forcedMode || classifyIntent(query);
  let answer;
  switch (mode) {
    case 'calendar': answer = await handleCalendar(query); break;
    case 'study':    answer = await handleStudy(query); break;
    case 'church':   answer = await handleChurch(query, {}); break;
    case 'prayer':   answer = await handlePrayer(query); break;
    case 'pastoral': answer = await handlePastoral(query); break;
    case 'ops':      answer = await handleOps(query, {}); break;
    default:         answer = { type: 'general', answer: 'No specialized handler; routed to general.' };
  }
  printJSON({ query, mode, ...answer });
}

async function cmdPastoral(args) {
  const { handlePastoral } = loadPipeline();
  const query = args.join(' ');
  if (!query) printError('Usage: pastoral <query...>');
  printJSON({ query, mode: 'pastoral', ...(await handlePastoral(query)) });
}

async function cmdOps(args) {
  const { handleOps } = loadPipeline();
  const query = args.join(' ');
  if (!query) printError('Usage: ops <query...>');
  printJSON({ query, mode: 'ops', ...(await handleOps(query, {})) });
}

// ---------------------------------------------------------------------------
// Procedure memory commands
// ---------------------------------------------------------------------------

async function cmdProcedures(args) {
  const db = loadDB();
  // Parse flags
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approved')       { flags.approved = true; }
    else if (args[i] === '--draft')     { flags.draft = true; }
    else if (args[i] === '--by' && args[i + 1]) { flags.by = args[++i]; }
    else positional.push(args[i]);
  }
  const [sub, ...rest] = positional;

  if (sub === 'list') {
    let approved;
    if (flags.approved) approved = true;
    else if (flags.draft) approved = false;
    const rows = db.listProcedures({ approved, limit: 200 });
    if (rows.length === 0) {
      console.log('No procedures found.');
      return;
    }
    console.log(`\n\x1b[1mProcedures (${rows.length})\x1b[0m\n`);
    for (const p of rows) {
      const status = p.approved ? '\x1b[32m✓ approved\x1b[0m' : '\x1b[33m⏳ draft\x1b[0m';
      const conf   = p.confidence != null ? ` conf=${(p.confidence * 100).toFixed(0)}%` : '';
      console.log(`  \x1b[36m${p.slug.padEnd(45)}\x1b[0m ${status}${conf}  risk=\x1b[${p.risk_level === 'destructive' ? '31' : p.risk_level === 'high' ? '33' : '32'}m${p.risk_level}\x1b[0m`);
      console.log(`    ${p.title}`);
    }
    console.log('');

  } else if (sub === 'search') {
    const query = rest.join(' ');
    if (!query) printError('Usage: procedures search <query>');
    const rows = db.listProcedures({ limit: 200 });
    const q = query.toLowerCase();
    const hits = rows.filter((p) =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.procedure_body || '').toLowerCase().includes(q) ||
      (p.intent_key || '').toLowerCase().includes(q) ||
      (p.slug || '').toLowerCase().includes(q)
    );
    if (hits.length === 0) {
      console.log(`No procedures matching "${query}".`);
      return;
    }
    console.log(`\n\x1b[1mProcedures matching "${query}" (${hits.length})\x1b[0m\n`);
    for (const p of hits) {
      const status = p.approved ? '\x1b[32m✓\x1b[0m' : '\x1b[33m⏳\x1b[0m';
      console.log(`  ${status} \x1b[36m${p.slug}\x1b[0m — ${p.title}`);
    }
    console.log('');

  } else if (sub === 'show') {
    const slug = rest[0];
    if (!slug) printError('Usage: procedures show <slug>');
    const p = db.getProcedureBySlug(slug);
    if (!p) printError(`Procedure not found: ${slug}`);
    console.log(`\n\x1b[1m${p.title}\x1b[0m`);
    console.log(`  Slug        : \x1b[36m${p.slug}\x1b[0m`);
    console.log(`  Intent key  : ${p.intent_key}`);
    console.log(`  Mode        : ${p.mode}`);
    console.log(`  Risk level  : \x1b[${p.risk_level === 'destructive' ? '31' : p.risk_level === 'high' ? '33' : '32'}m${p.risk_level}\x1b[0m`);
    console.log(`  Confidence  : ${p.confidence != null ? (p.confidence * 100).toFixed(0) + '%' : 'n/a'}`);
    console.log(`  Approved    : ${p.approved ? '\x1b[32myes\x1b[0m' + (p.approved_by ? ' (by ' + p.approved_by + ')' : '') : '\x1b[33mno (draft)\x1b[0m'}`);
    console.log(`  Usage count : ${p.usage_count || 0}${p.last_used_at ? ' (last: ' + p.last_used_at + ')' : ''}`);
    console.log(`  Source type : ${p.source_type || 'n/a'}${p.source_decision_id ? ' (decision ' + p.source_decision_id + ')' : ''}`);
    console.log(`  Created     : ${p.created_at}`);
    if (p.trigger_examples) {
      try {
        const ex = JSON.parse(p.trigger_examples);
        console.log(`\n  \x1b[33mTrigger examples:\x1b[0m`);
        for (const e of ex) console.log(`    • ${e}`);
      } catch (_) {}
    }
    console.log(`\n  \x1b[33mProcedure body:\x1b[0m`);
    console.log(p.procedure_body.split('\n').map((l) => '    ' + l).join('\n'));
    if (p.commands_json) {
      try {
        const cmds = JSON.parse(p.commands_json);
        console.log(`\n  \x1b[33mCommands:\x1b[0m`);
        for (const c of cmds) {
          console.log(`    \x1b[36m$ ${c.cmd}\x1b[0m`);
          if (c.description) console.log(`      ${c.description}`);
          if (c.expected_output) console.log(`      Expected: ${c.expected_output}`);
        }
      } catch (_) {}
    }
    if (p.validation_steps) {
      try {
        const steps = JSON.parse(p.validation_steps);
        console.log(`\n  \x1b[33mValidation steps:\x1b[0m`);
        for (const s of steps) console.log(`    ✓ ${s}`);
      } catch (_) {}
    }
    console.log('');

  } else if (sub === 'approve') {
    const slug = rest[0];
    if (!slug) printError('Usage: procedures approve <slug> [--by <who>]');
    const p = db.getProcedureBySlug(slug);
    if (!p) printError(`Procedure not found: ${slug}`);
    if (p.approved) {
      console.log(`\x1b[33mAlready approved:\x1b[0m ${slug}`);
      return;
    }
    const approved_by = flags.by || process.env.USER || 'operator';
    db.approveProcedure(p.id, { approved_by });
    console.log(`\x1b[32m✓ Approved:\x1b[0m ${slug} (by ${approved_by})`);

  } else if (sub === 'reject') {
    const slug = rest[0];
    if (!slug) printError('Usage: procedures reject <slug> [--by <who>]');
    const p = db.getProcedureBySlug(slug);
    if (!p) printError(`Procedure not found: ${slug}`);
    const rejected_by = flags.by || process.env.USER || 'operator';
    db.rejectProcedure(p.id, { rejected_by });
    console.log(`\x1b[31m✗ Rejected:\x1b[0m ${slug} (by ${rejected_by})`);

  } else if (sub === 'revise') {
    const slug = rest[0];
    if (!slug) printError('Usage: procedures revise <slug> [--by <who>]');
    const p = db.getProcedureBySlug(slug);
    if (!p) printError(`Procedure not found: ${slug}`);
    const rejected_by = flags.by || process.env.USER || 'operator';
    // Reject and add a correction entry to signal revision needed
    db.rejectProcedure(p.id, { rejected_by });
    // Log a correction so the retrieval pipeline knows this procedure needs work
    const crypto = require('crypto');
    db.appendCorrection({
      id: crypto.randomUUID(),
      procedure_id: p.id,
      correction_type: 'failed_reuse',
      wrong_answer: p.procedure_body.slice(0, 200),
      correct_answer: '(revision required — procedure marked for rework by ' + rejected_by + ')',
      explanation: 'Operator marked procedure for revision via CLI.',
      submitted_by: rejected_by,
    });
    console.log(`\x1b[33m⟳ Marked for revision:\x1b[0m ${slug} (by ${rejected_by})`);
    console.log('  Procedure rejected and correction entry added. Edit the procedure body and re-approve.');

  } else {
    printError(`Unknown procedures subcommand: ${sub}. Use: list, search, show, approve, reject, revise`);
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Knowledge memory commands
// ---------------------------------------------------------------------------

async function cmdKnowledge(args) {
  const db = loadDB();
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) { flags.category = args[++i]; }
    else positional.push(args[i]);
  }
  const [sub, ...rest] = positional;

  if (sub === 'list') {
    const rows = db.listKnowledge({ category: flags.category, limit: 200 });
    if (rows.length === 0) { console.log('No knowledge documents found.'); return; }
    console.log(`\n\x1b[1mKnowledge (${rows.length})\x1b[0m\n`);
    for (const k of rows) {
      const conf = k.confidence != null ? ` conf=${(k.confidence * 100).toFixed(0)}%` : '';
      console.log(`  \x1b[36m${k.slug.padEnd(40)}\x1b[0m [${k.category}]${conf}`);
      console.log(`    ${k.title}`);
    }
    console.log('');

  } else if (sub === 'search') {
    const query = rest.join(' ');
    if (!query) printError('Usage: knowledge search <query>');
    const rows = db.searchKnowledge(query, { category: flags.category, limit: 20 });
    if (rows.length === 0) { console.log(`No knowledge matching "${query}".`); return; }
    console.log(`\n\x1b[1mKnowledge matching "${query}" (${rows.length})\x1b[0m\n`);
    for (const k of rows) {
      console.log(`  \x1b[36m${k.slug}\x1b[0m — ${k.title} [${k.category}]`);
    }
    console.log('');

  } else if (sub === 'show') {
    const slug = rest[0];
    if (!slug) printError('Usage: knowledge show <slug>');
    const k = db.getKnowledgeBySlug(slug);
    if (!k) printError(`Knowledge document not found: ${slug}`);
    console.log(`\n\x1b[1m${k.title}\x1b[0m`);
    console.log(`  Slug       : \x1b[36m${k.slug}\x1b[0m`);
    console.log(`  Category   : ${k.category}`);
    console.log(`  Confidence : ${k.confidence != null ? (k.confidence * 100).toFixed(0) + '%' : 'n/a'}`);
    console.log(`  Source     : ${k.source_ref || 'n/a'}`);
    console.log(`  Updated    : ${k.updated_at}`);
    console.log(`\n  \x1b[33mBody:\x1b[0m`);
    console.log(k.body.split('\n').map((l) => '    ' + l).join('\n'));
    console.log('');

  } else {
    printError(`Unknown knowledge subcommand: ${sub}. Use: list, search, show`);
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Task memory commands
// ---------------------------------------------------------------------------

async function cmdTasks(args) {
  const db = loadDB();
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) { flags.status = args[++i]; }
    else positional.push(args[i]);
  }
  const [sub, ...rest] = positional;

  if (sub === 'list') {
    const status = flags.status || 'open';
    const rows = db.listTasks({ status, limit: 200 });
    if (rows.length === 0) { console.log(`No ${status} tasks.`); return; }
    console.log(`\n\x1b[1mTasks — ${status} (${rows.length})\x1b[0m\n`);
    for (const t of rows) {
      const due = t.due_at ? ` due=${t.due_at.slice(0, 10)}` : '';
      const pri = t.priority === 'high' ? '\x1b[31m!\x1b[0m' : t.priority === 'low' ? '\x1b[2m·\x1b[0m' : '·';
      console.log(`  ${pri} \x1b[36m${t.id.slice(0, 8)}\x1b[0m  ${t.title}${due}`);
    }
    console.log('');

  } else if (sub === 'show') {
    const id = rest[0];
    if (!id) printError('Usage: tasks show <id>');
    // Support partial UUID prefix
    const rows = db.listTasks({ limit: 1000 });
    const t = rows.find((r) => r.id === id || r.id.startsWith(id));
    if (!t) printError(`Task not found: ${id}`);
    printJSON(t);

  } else {
    printError(`Unknown tasks subcommand: ${sub}. Use: list, show`);
  }

  db.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  try {
    if      (cmd === 'calendar')   await cmdCalendar(args);
    else if (cmd === 'doctrine')   await cmdDoctrine(args);
    else if (cmd === 'scripture')  await cmdScripture(args);
    else if (cmd === 'church')     await cmdChurch(args);
    else if (cmd === 'mode')       await cmdMode(args);
    else if (cmd === 'ask')        await cmdAsk(args);
    else if (cmd === 'pastoral')   await cmdPastoral(args);
    else if (cmd === 'ops')        await cmdOps(args);
    else if (cmd === 'procedures') await cmdProcedures(args);
    else if (cmd === 'knowledge')  await cmdKnowledge(args);
    else if (cmd === 'tasks')      await cmdTasks(args);
    else { printHelp(); printError(`Unknown command: ${cmd}`); }
  } catch (err) {
    printError(err.message);
  }
}

main();
