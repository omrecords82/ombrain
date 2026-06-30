#!/usr/bin/env node
'use strict';

/**
 * Daily ops-auth expiry check for om-brain.
 * Invoked by om-brain-ops-auth-check.timer — logs redacted warnings only (no JWT).
 *
 * Exit codes:
 *   0 — healthy (valid, >14 days until expiry)
 *   1 — near expiry (within 14 days)
 *   2 — expired, missing, or malformed JWT
 *   3 — could not reach /status
 */

const http = require('http');
const { URL } = require('url');

const STATUS_URL = process.env.OMBRAIN_STATUS_URL || 'http://127.0.0.1:8390/status';
const TIMEOUT_MS = Number(process.env.OMBRAIN_OPS_AUTH_CHECK_TIMEOUT_MS) || 15000;

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error(`invalid status url: ${url}`));
      return;
    }
    const req = http.get(parsed, { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`status HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('status response not JSON'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('status request timed out'));
    });
    req.on('error', reject);
  });
}

function exitCodeForOpsAuth(auth) {
  if (!auth) return 3;
  if (!auth.valid) return 2;
  if (auth.needs_attention || auth.health === 'near_expiry') return 1;
  if (auth.days_until_expiry != null && auth.days_until_expiry <= (auth.warn_threshold_days || 14)) return 1;
  return 0;
}

async function main() {
  let payload;
  try {
    payload = await fetchStatus(STATUS_URL);
  } catch (e) {
    console.error(`[om-brain-ops-auth-check] ERROR: could not fetch ${STATUS_URL}: ${e.message}`);
    process.exit(3);
  }

  const auth = payload && payload.ops_auth;
  if (!auth) {
    console.error('[om-brain-ops-auth-check] ERROR: /status missing ops_auth block');
    process.exit(3);
  }

  const code = exitCodeForOpsAuth(auth);
  const summary = {
    valid: auth.valid,
    health: auth.health,
    expires_at: auth.expires_at,
    days_until_expiry: auth.days_until_expiry,
    warning: auth.warning || null,
  };

  if (code === 0) {
    console.log(`[om-brain-ops-auth-check] OK: ops JWT valid, ${auth.days_until_expiry} day(s) until expiry (${auth.expires_at})`);
    process.exit(0);
  }

  const level = code === 2 ? 'CRITICAL' : 'WARNING';
  console.error(`[om-brain-ops-auth-check] ${level}: ${auth.warning || 'ops auth needs attention'}`);
  console.error(`[om-brain-ops-auth-check] detail: ${JSON.stringify(summary)}`);
  console.error('[om-brain-ops-auth-check] action: provision-brain-ingest.sh --update-auth01 on OMAI host');
  process.exit(code);
}

main();
