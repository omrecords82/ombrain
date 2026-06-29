'use strict';

const logger = require('../util/logger');

const DEFAULT_NATS_URL = process.env.NATS_URL || 'nats://127.0.0.1:4222';
const DEFAULT_TIMEOUT_MS = Number(process.env.FLEET_NATS_TIMEOUT_MS) || 120000;

let sharedNc = null;
let connectPromise = null;

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Reject NATS URLs that point outside LAN/loopback (circuit breaker).
 */
function assertLanNatsUrl(url = DEFAULT_NATS_URL) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    const err = new Error(`invalid NATS_URL: ${url}`);
    err.code = 'nats_url_invalid';
    throw err;
  }
  if (!['nats:', 'tls:'].includes(parsed.protocol)) {
    const err = new Error(`unsupported NATS protocol: ${parsed.protocol}`);
    err.code = 'nats_url_invalid';
    throw err;
  }
  if (!isPrivateOrLoopbackHost(parsed.hostname)) {
    const err = new Error(`NATS_URL must be LAN/loopback only: ${parsed.hostname}`);
    err.code = 'nats_url_external_blocked';
    throw err;
  }
  return parsed.toString();
}

function spawnSubject(hostId) {
  return `brain.fleet.spawn.${hostId}`;
}

async function getNatsConnection(options = {}) {
  const url = assertLanNatsUrl(options.url || DEFAULT_NATS_URL);
  if (sharedNc && !sharedNc.isClosed()) {
    return sharedNc;
  }
  if (!connectPromise) {
    connectPromise = (async () => {
      let nats;
      try {
        nats = require('nats');
      } catch (e) {
        const err = new Error('nats package not installed');
        err.code = 'nats_package_missing';
        throw err;
      }
      const servers = url;
      const token = process.env.NATS_TOKEN || undefined;
      logger.info('fleet_nats_connect', { servers: servers.replace(/\/\/.*@/, '//[redacted]@') });
      const nc = await nats.connect({ servers, token, maxReconnectAttempts: 3 });
      sharedNc = nc;
      return nc;
    })().finally(() => {
      connectPromise = null;
    });
  }
  return connectPromise;
}

async function closeNatsConnection() {
  if (sharedNc && !sharedNc.isClosed()) {
    await sharedNc.close();
  }
  sharedNc = null;
}

function resolveFleetTransport(explicit) {
  if (explicit === 'ssh' || explicit === 'nats') return explicit;
  const env = (process.env.FLEET_TRANSPORT || '').toLowerCase();
  if (env === 'ssh' || env === 'nats') return env;
  if (process.env.NATS_URL) return 'nats';
  return 'nats';
}

module.exports = {
  DEFAULT_NATS_URL,
  DEFAULT_TIMEOUT_MS,
  assertLanNatsUrl,
  spawnSubject,
  getNatsConnection,
  closeNatsConnection,
  resolveFleetTransport,
  isPrivateOrLoopbackHost,
};
