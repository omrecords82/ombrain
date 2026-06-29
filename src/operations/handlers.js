'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runScan, DEFAULT_SNAPSHOT } = require('../docRegistry');

const ROOT = path.resolve(__dirname, '..', '..');

function summarizeStats(stats) {
  if (!stats) return 'completed';
  const parts = [`${stats.total} paths`];
  if (stats.by_status) {
    for (const [k, v] of Object.entries(stats.by_status).sort()) {
      parts.push(`${k}=${v}`);
    }
  }
  parts.push(`commit=${!!stats.commit}`);
  return parts.join(', ');
}

function runDocRegistryScan(db, opts = {}) {
  const dryRun = opts.dry_run != null ? !!opts.dry_run : !opts.commit;
  const commit = !dryRun && !!opts.commit;
  const result = runScan(commit ? db : null, {
    commit,
    rootsPath: opts.rootsPath,
    structurePath: opts.structurePath,
    outPath: opts.outPath || DEFAULT_SNAPSHOT,
  });
  return {
    ok: true,
    dry_run: !commit,
    stats: result.stats,
    snapshot_path: result.snapshotPath,
    output_summary: summarizeStats(result.stats),
    exit_code: 0,
  };
}

function spawnScript(scriptRel, extraArgs = []) {
  const scriptPath = path.join(ROOT, scriptRel);
  if (!fs.existsSync(scriptPath)) {
    const err = new Error(`script not found: ${scriptRel}`);
    err.exitCode = 1;
    throw err;
  }
  const proc = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = (proc.stdout || '').trim();
  const stderr = (proc.stderr || '').trim();
  if (proc.status !== 0) {
    const err = new Error(stderr || stdout || `script exited ${proc.status}`);
    err.exitCode = proc.status == null ? 1 : proc.status;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return {
    ok: true,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 1000),
    output_summary: stdout.split('\n').filter(Boolean).pop() || 'completed',
    exit_code: 0,
  };
}

function runHostSnapshot(_db, _opts = {}) {
  return spawnScript('scripts/collect-hosts.js');
}

function runSchemaSnapshot(_db, _opts = {}) {
  return spawnScript('scripts/dump-schema.js');
}

const HANDLERS = {
  docRegistryScan: runDocRegistryScan,
  hostSnapshot: runHostSnapshot,
  schemaSnapshot: runSchemaSnapshot,
};

function runHandler(handlerRef, db, opts) {
  const fn = HANDLERS[handlerRef];
  if (!fn) {
    const err = new Error(`unknown handler: ${handlerRef}`);
    err.exitCode = 1;
    throw err;
  }
  return fn(db, opts);
}

module.exports = {
  runHandler,
  runDocRegistryScan,
  runHostSnapshot,
  runSchemaSnapshot,
  HANDLERS,
};
