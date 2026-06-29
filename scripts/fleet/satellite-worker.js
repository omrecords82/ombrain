#!/usr/bin/env node
'use strict';

/**
 * om-brain fleet satellite worker — subscribes for spawn requests on this host.
 * Runs ONLY allowlisted handler scripts; never arbitrary shell from NATS payloads.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { StringCodec } = require('nats');

const {
  assertAllowlistedHandler,
  assertAllowlistedOperation,
} = require('../../src/fleet/handlers');
const {
  assertLanNatsUrl,
  spawnSubject,
  DEFAULT_NATS_URL,
} = require('../../src/fleet/natsClient');

const sc = StringCodec();

const HOST_ID = process.env.SATELLITE_HOST_ID || process.env.HOSTNAME || '';
const ROOT = process.env.OM_BRAIN_ROOT || '/opt/om-brain';
const NATS_URL = process.env.NATS_URL || DEFAULT_NATS_URL;
const TIMEOUT_MS = Number(process.env.FLEET_NATS_TIMEOUT_MS) || 120000;

function log(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, host: HOST_ID, ...fields });
  process.stdout.write(`${line}\n`);
}

function runHandler(handlerRef, env = {}) {
  const scriptAbs = assertAllowlistedHandler(handlerRef, ROOT);
  const proc = spawnSync('bash', [scriptAbs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: {
      ...process.env,
      ...env,
      HOSTNAME: HOST_ID,
    },
  });
  return {
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
    exit_code: proc.status == null ? 1 : proc.status,
  };
}

function handleSpawnRequest(raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    return {
      stdout: '',
      stderr: `invalid spawn payload: ${e.message}`,
      exit_code: 1,
    };
  }

  try {
    if (!req.operation_id) {
      throw new Error('operation_id required');
    }
    assertAllowlistedOperation(req.operation_id);
    if (!req.handler_ref) {
      throw new Error('handler_ref required');
    }
    if (req.host && req.host !== HOST_ID) {
      throw new Error(`host mismatch: expected ${HOST_ID}, got ${req.host}`);
    }
    return runHandler(req.handler_ref, req.env || {});
  } catch (e) {
    return {
      stdout: '',
      stderr: e.message || 'spawn rejected',
      exit_code: 1,
    };
  }
}

async function main() {
  if (!HOST_ID) {
    console.error('SATELLITE_HOST_ID is required');
    process.exit(1);
  }
  if (!fs.existsSync(ROOT)) {
    console.error(`OM_BRAIN_ROOT not found: ${ROOT}`);
    process.exit(1);
  }

  const url = assertLanNatsUrl(NATS_URL);
  const subject = spawnSubject(HOST_ID);

  let nats;
  try {
    nats = require('nats');
  } catch (e) {
    console.error('nats package not installed');
    process.exit(1);
  }

  const token = process.env.NATS_TOKEN || undefined;
  const nc = await nats.connect({ servers: url, token, maxReconnectAttempts: -1 });

  log('satellite_start', { subject, root: ROOT, nats_url: url.replace(/\/\/.*@/, '//[redacted]@') });

  const sub = nc.subscribe(subject, { queue: `satellite-${HOST_ID}` });
  (async () => {
    for await (const msg of sub) {
      const raw = sc.decode(msg.data);
      log('spawn_received', { run_id: (() => { try { return JSON.parse(raw).run_id; } catch { return null; } })() });
      const result = handleSpawnRequest(raw);
      if (msg.reply) {
        nc.publish(msg.reply, sc.encode(JSON.stringify(result)));
      }
    }
  })().catch((e) => {
    log('satellite_fatal', { error: e.message });
    process.exit(1);
  });

  const shutdown = async () => {
    log('satellite_shutdown');
    await nc.drain();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
