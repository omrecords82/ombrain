'use strict';

/**
 * Deployment / repository version reporting for drift detection.
 *
 * Reads optional stamp files and env; never invents a "healthy/in-sync"
 * claim when data is missing.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

function readTrimmed(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim() || null;
  } catch (_) {
    return null;
  }
}

function shortSha(sha) {
  if (!sha) return null;
  const s = String(sha).trim();
  return s.length > 12 ? s.slice(0, 12) : s;
}

function gitRevParse(repoPath, rev) {
  try {
    return String(
      execFileSync('git', ['-C', repoPath, 'rev-parse', rev], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
  } catch (_) {
    return null;
  }
}

/**
 * Build a deployment version report.
 *
 * @param {object} opts
 * @param {string} [opts.repoPath]
 * @param {object} [opts.env]
 * @param {object} [opts.componentCommits] map of component → deployed full/short sha
 */
function buildDeploymentVersionReport(opts = {}) {
  const env = opts.env || process.env;
  const repoPath = opts.repoPath || env.BRAIN_REPO_PATH || '/var/www/omai';

  const originMain =
    env.BRAIN_ORIGIN_MAIN_COMMIT ||
    readTrimmed(env.BRAIN_ORIGIN_MAIN_COMMIT_FILE || '') ||
    gitRevParse(repoPath, 'origin/main');

  const components = opts.componentCommits || {
    om_brain_backend:
      env.BRAIN_DEPLOYED_COMMIT ||
      readTrimmed(env.BRAIN_DEPLOYED_COMMIT_FILE || '/etc/om-brain/deployed-commit') ||
      readTrimmed('/opt/om-brain/DEPLOYED_COMMIT'),
    om_brain_console:
      env.BRAIN_CONSOLE_DEPLOYED_COMMIT ||
      readTrimmed(env.BRAIN_CONSOLE_DEPLOYED_COMMIT_FILE || '/etc/om-brain/console-deployed-commit') ||
      readTrimmed('/opt/om-brain-console/DEPLOYED_COMMIT'),
    omai_frontend:
      env.OMAI_FRONTEND_DEPLOYED_COMMIT ||
      readTrimmed(env.OMAI_FRONTEND_DEPLOYED_COMMIT_FILE || '/etc/om-brain/omai-frontend-deployed-commit') ||
      readTrimmed('/var/www/omai/DEPLOYED_COMMIT'),
  };

  const rows = {};
  let anyUnknown = false;
  let anyDrift = false;

  for (const [name, deployed] of Object.entries(components)) {
    const deployedFull = deployed || null;
    const inSync =
      deployedFull && originMain
        ? String(deployedFull).trim() === String(originMain).trim() ||
          shortSha(deployedFull) === shortSha(originMain)
        : null;
    if (!deployedFull) anyUnknown = true;
    if (inSync === false) anyDrift = true;
    rows[name] = {
      deployed_commit: deployedFull,
      deployed_commit_short: shortSha(deployedFull),
      origin_main: originMain,
      origin_main_short: shortSha(originMain),
      in_sync_with_origin_main: inSync,
    };
  }

  let drift_status = 'unknown';
  if (!originMain || anyUnknown) drift_status = 'unknown';
  else if (anyDrift) drift_status = 'drift';
  else drift_status = 'in_sync';

  return {
    origin_main: originMain,
    origin_main_short: shortSha(originMain),
    components: rows,
    drift_status,
  };
}

module.exports = {
  buildDeploymentVersionReport,
  shortSha,
  readTrimmed,
};
