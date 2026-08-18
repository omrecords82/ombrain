'use strict';

/**
 * Shared JSON client for calling om-brain directly from the console server
 * (used by the briefing synthesizer). Distinct from the raw streaming proxy
 * in index.js, which forwards browser calls verbatim.
 */

const http = require('http');

const BRAIN_BASE = (process.env.OM_BRAIN_URL || 'http://127.0.0.1:8390').replace(/\/$/, '');
const SERVICE_TOKEN = process.env.OMSTUDIO_SERVICE_TOKEN || '';
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * @returns {Promise<{ok: boolean, status: number|null, latencyMs: number, json: any, error: string|null}>}
 */
function brainFetch(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(path.startsWith('/') ? path : `/${path}`, `${BRAIN_BASE}/`);
    } catch (err) {
      resolve({ ok: false, status: null, latencyMs: 0, json: null, error: `invalid_url: ${err.message}` });
      return;
    }

    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (SERVICE_TOKEN) headers.Authorization = `Bearer ${SERVICE_TOKEN}`;

    const req = http.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const latencyMs = Date.now() - started;
        const text = Buffer.concat(chunks).toString('utf8');
        const statusOk = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
        let json = null;
        let parseError = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch (err) {
            parseError = 'non_json_response';
          }
        }
        resolve({
          ok: statusOk && !parseError,
          status: res.statusCode || null,
          latencyMs,
          json,
          error: !statusOk ? `http_${res.statusCode}` : parseError,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, latencyMs: Date.now() - started, json: null, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: null, latencyMs: Date.now() - started, json: null, error: err.message });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function brainGet(path, timeoutMs) {
  return brainFetch('GET', path, null, timeoutMs);
}

function brainPost(path, body, timeoutMs) {
  return brainFetch('POST', path, body, timeoutMs);
}

module.exports = { BRAIN_BASE, brainFetch, brainGet, brainPost };
