'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const logger = require('../../util/logger');
const { ROOT } = require('../hosts');
const {
  ALLOWED_HANDLER_PREFIX,
  assertAllowlistedHandler,
} = require('../handlers');
const DEFAULT_SSH_USER = process.env.FLEET_SSH_USER || 'next';
const DEFAULT_SSH_IDENTITY_FILE = process.env.FLEET_SSH_IDENTITY_FILE || '';
const DEFAULT_TIMEOUT_MS = Number(process.env.FLEET_SSH_TIMEOUT_MS) || 120000;

/**
 * Execute an allowlisted handler script on a remote host via SSH (stdin pipe).
 *
 * @param {object} hostConfig - inventory host row { name, ip, ... }
 * @param {string} handlerRef - relative path under om-brain root
 * @param {object} [env] - extra env vars for remote script
 * @returns {{ stdout: string, stderr: string, exit_code: number }}
 */
function execute(hostConfig, handlerRef, env = {}) {
  const scriptAbs = assertAllowlistedHandler(handlerRef, ROOT);
  const scriptContent = fs.readFileSync(scriptAbs, 'utf8');
  const remoteTarget = `${DEFAULT_SSH_USER}@${hostConfig.ip}`;

  logger.info('fleet_ssh_execute', {
    host: hostConfig.name,
    ip: hostConfig.ip,
    handler: handlerRef,
  });

  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=30',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (DEFAULT_SSH_IDENTITY_FILE) {
    sshArgs.push('-i', DEFAULT_SSH_IDENTITY_FILE);
    const knownHosts = path.join(path.dirname(DEFAULT_SSH_IDENTITY_FILE), 'known_hosts');
    sshArgs.push('-o', `UserKnownHostsFile=${knownHosts}`);
  }
  sshArgs.push(remoteTarget, 'bash', '-s');

  const proc = spawnSync('ssh', sshArgs, {
    input: scriptContent,
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      ...env,
      HOSTNAME: hostConfig.name,
    },
  });

  return {
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
    exit_code: proc.status == null ? 1 : proc.status,
    signal: proc.signal || null,
  };
}

/**
 * Run handler locally (for tests and dry-run without SSH).
 */
function executeLocal(_hostConfig, handlerRef, env = {}) {
  const scriptAbs = assertAllowlistedHandler(handlerRef, ROOT);
  const proc = spawnSync('bash', [scriptAbs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      ...env,
      HOSTNAME: _hostConfig.name,
    },
  });
  return {
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
    exit_code: proc.status == null ? 1 : proc.status,
    signal: proc.signal || null,
  };
}

module.exports = {
  ALLOWED_HANDLER_PREFIX,
  DEFAULT_SSH_USER,
  DEFAULT_SSH_IDENTITY_FILE,
  DEFAULT_TIMEOUT_MS,
  assertAllowlistedHandler,
  execute,
  executeLocal,
};
