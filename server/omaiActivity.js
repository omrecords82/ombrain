'use strict';

const http = require('http');
const https = require('https');

const OMAI_ACTIVITY_URL = process.env.OMAI_BRAIN_ACTIVITY_URL
  || 'http://192.168.1.239:7060/api/brain/activity';
const OMAI_ACTIVITY_TOKEN = process.env.OMAI_BRAIN_ACTIVITY_TOKEN || '';
const TIMEOUT_MS = Number(process.env.OMAI_ACTIVITY_TIMEOUT_MS || 3000);

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      { method: 'GET', headers: { Accept: 'application/json', ...headers }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`OMAI activity HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('OMAI activity returned non-JSON'));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('OMAI activity timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Best-effort fetch of OMAI proxy activity — never blocks console health. */
async function fetchOmaiProxyActivity(limit = 20) {
  const headers = {};
  if (OMAI_ACTIVITY_TOKEN) {
    headers.Authorization = `Bearer ${OMAI_ACTIVITY_TOKEN}`;
  }
  const data = await fetchJson(`${OMAI_ACTIVITY_URL}?limit=${encodeURIComponent(String(limit))}`, headers);
  if (!data || !Array.isArray(data.activity)) {
    return { ok: false, unavailable: true, activity: [] };
  }
  return { ok: true, unavailable: false, ...data };
}

module.exports = { fetchOmaiProxyActivity };
