'use strict';

const { StringCodec } = require('nats');
const logger = require('../../util/logger');
const { assertAllowlistedHandler } = require('../handlers');
const { ROOT } = require('../hosts');
const {
  getNatsConnection,
  spawnSubject,
  DEFAULT_TIMEOUT_MS,
} = require('../natsClient');

const sc = StringCodec();

/**
 * Dispatch an allowlisted handler to a satellite via NATS request/reply.
 *
 * @param {object} hostConfig - inventory host row { name, ip, ... }
 * @param {string} handlerRef - relative path under om-brain root
 * @param {object} [env] - extra env vars for remote script
 * @param {object} [meta] - { runId, parentRunId, operationId, params }
 * @returns {Promise<{ stdout: string, stderr: string, exit_code: number }>}
 */
async function execute(hostConfig, handlerRef, env = {}, meta = {}) {
  assertAllowlistedHandler(handlerRef, ROOT);

  const hostId = hostConfig.name;
  const subject = spawnSubject(hostId);
  const payload = {
    run_id: meta.runId || null,
    parent_run_id: meta.parentRunId || null,
    operation_id: meta.operationId || null,
    task_id: meta.taskId || null,
    handler_ref: handlerRef,
    host: hostId,
    params: meta.params || {},
    env: env || {},
  };

  logger.info('fleet_nats_execute', {
    host: hostId,
    subject,
    handler: handlerRef,
    run_id: payload.run_id,
    parent_run_id: payload.parent_run_id,
  });

  let nc;
  try {
    nc = await getNatsConnection();
  } catch (e) {
    return {
      stdout: '',
      stderr: e.message || 'nats connect failed',
      exit_code: 1,
    };
  }

  const timeoutMs = Number(process.env.FLEET_NATS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  try {
    const msg = await nc.request(subject, sc.encode(JSON.stringify(payload)), {
      timeout: timeoutMs,
    });
    const raw = sc.decode(msg.data);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        stdout: '',
        stderr: `invalid JSON from satellite: ${(e.message || 'parse error').slice(0, 200)}`,
        exit_code: 1,
      };
    }
    return {
      stdout: String(parsed.stdout || '').trim(),
      stderr: String(parsed.stderr || '').trim(),
      exit_code: parsed.exit_code != null ? parsed.exit_code : 1,
    };
  } catch (e) {
    const code = e.code || e.name || 'nats_error';
    return {
      stdout: '',
      stderr: `${code}: ${(e.message || 'nats request failed').slice(0, 500)}`,
      exit_code: 1,
    };
  }
}

module.exports = { execute, spawnSubject };
