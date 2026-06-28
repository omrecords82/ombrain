'use strict';

/**
 * Execute memorized skill scripts with timeout and run logging.
 * Dry-run is the default; set execute:true / commit:true to run for real.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { validateSkillScript, sanitizeRunEnv } = require('./skillSafety');
const { redactForLog } = require('../ai/redactor');
const logger = require('../util/logger');

const DEFAULT_TIMEOUT_MS = 120000;

function resolveRunsDir(customDir) {
  if (customDir) return customDir;
  const base = process.env.BRAIN_DATA_DIR || path.dirname(process.env.BRAIN_DB_PATH || './data/brain.db');
  return path.join(base, 'skills-runs');
}

function buildDryRunPlan(skill, args = []) {
  return {
    dry_run: true,
    skill_key: skill.skill_key,
    language: skill.language,
    title: skill.title,
    args,
    script_preview: String(skill.script_body || '').slice(0, 500),
    message: 'Dry-run only. Pass execute:true or commit:true to run.',
  };
}

function writeRunLog(runsDir, entry) {
  try {
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(runsDir, `${entry.skill_key}-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(redactForLog(entry), null, 2));
    return file;
  } catch (e) {
    logger.warn('skill_run_log_error', { name: e && e.name });
    return null;
  }
}

function runProcess(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: cwd || os.tmpdir(),
      env: { ...process.env, ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: timedOut ? 124 : (code != null ? code : 1),
        signal: signal || null,
        timed_out: timedOut,
        stdout: stdout.slice(0, 32768),
        stderr: stderr.slice(0, 8192),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: 1,
        signal: null,
        timed_out: false,
        stdout: '',
        stderr: String(err && err.message),
      });
    });
  });
}

async function executeSkill(skill, opts = {}) {
  const execute = !!(opts.execute || opts.commit);
  const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const env = sanitizeRunEnv(opts.env || {});
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const noLive = !!(opts.noLive || process.env.OMBRAIN_SKILLS_NO_LIVE === '1');

  const validation = validateSkillScript({
    script_body: skill.script_body,
    language: skill.language,
  });
  if (!validation.ok) {
    return {
      ok: false,
      executed: false,
      dry_run: !execute,
      skill_key: skill.skill_key,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  if (!execute) {
    return {
      ok: true,
      executed: false,
      ...buildDryRunPlan(skill, args),
      warnings: validation.warnings.length ? validation.warnings : undefined,
    };
  }

  if (noLive) {
    return {
      ok: true,
      executed: true,
      dry_run: false,
      no_live: true,
      skill_key: skill.skill_key,
      language: skill.language,
      args,
      exit_code: 0,
      stdout: '[OMBRAIN_SKILLS_NO_LIVE] simulated success',
      stderr: '',
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ombrain-skill-'));
  const lang = skill.language;
  let cmd;
  let cmdArgs;

  try {
    if (lang === 'bash') {
      const scriptPath = path.join(tmpDir, 'skill.sh');
      fs.writeFileSync(scriptPath, skill.script_body, { mode: 0o700 });
      cmd = '/bin/bash';
      cmdArgs = [scriptPath, ...args];
    } else if (lang === 'python') {
      const scriptPath = path.join(tmpDir, 'skill.py');
      fs.writeFileSync(scriptPath, skill.script_body, { mode: 0o600 });
      cmd = process.env.OMBRAIN_PYTHON || 'python3';
      cmdArgs = [scriptPath, ...args];
    } else if (lang === 'node') {
      const scriptPath = path.join(tmpDir, 'skill.js');
      fs.writeFileSync(scriptPath, skill.script_body, { mode: 0o600 });
      cmd = process.execPath;
      cmdArgs = [scriptPath, ...args];
    } else {
      return { ok: false, executed: false, error: 'unsupported_language', language: lang };
    }

    const started = Date.now();
    const result = await runProcess(cmd, cmdArgs, { cwd: tmpDir, env, timeoutMs });
    const logEntry = {
      skill_key: skill.skill_key,
      language: lang,
      args,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
      executed_at: new Date().toISOString(),
    };
    const logFile = writeRunLog(resolveRunsDir(opts.runsDir), logEntry);

    return {
      ok: result.exit_code === 0 && !result.timed_out,
      executed: true,
      dry_run: false,
      skill_key: skill.skill_key,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: logEntry.duration_ms,
      log_file: logFile,
      warnings: validation.warnings.length ? validation.warnings : undefined,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildDryRunPlan,
  executeSkill,
  resolveRunsDir,
};
