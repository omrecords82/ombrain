'use strict';

/**
 * om-brain-console server
 *
 * Serves the React console UI and proxies /api/brain/* to local om-brain (127.0.0.1:8390).
 * Binds loopback by default; nginx exposes LAN edge on 192.168.1.254:8392.
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

const activityLog = require('./activityLog');
const { fetchOmaiProxyActivity } = require('./omaiActivity');
const { buildBriefing } = require('./briefing');

const HOST = process.env.CONSOLE_HOST || '127.0.0.1';
const PORT = Number(process.env.CONSOLE_PORT || 8392);
const BRAIN_BASE = (process.env.OM_BRAIN_URL || 'http://127.0.0.1:8390').replace(/\/$/, '');
const CONSOLE_AUTH_TOKEN = process.env.CONSOLE_AUTH_TOKEN || '';
const SERVICE_TOKEN = process.env.OMSTUDIO_SERVICE_TOKEN || '';
const STATIC_DIR = path.join(__dirname, '..', 'web', 'dist');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

function consoleAuth(req, res, next) {
  if (!CONSOLE_AUTH_TOKEN) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-console-token'];
  if (token === CONSOLE_AUTH_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'console_auth_required' });
}

function summarizeProxyError(statusCode, bodyText) {
  if (!bodyText) return statusCode >= 500 ? 'upstream_error' : `http_${statusCode}`;
  try {
    const json = JSON.parse(bodyText);
    return String(json.detail || json.error || json.message || `http_${statusCode}`).slice(0, 512);
  } catch (_) {
    return bodyText.slice(0, 512);
  }
}

function probeBrainHealth() {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/health', `${BRAIN_BASE}/`);
    } catch (_) {
      resolve({ ok: false, error: 'invalid_brain_base' });
      return;
    }

    const started = Date.now();
    const req = http.request(url, { method: 'GET', timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(text);
          resolve({
            ok: res.statusCode === 200 && json.ok !== false,
            status_code: res.statusCode,
            latency_ms: Date.now() - started,
            brain: json,
          });
        } catch (_) {
          resolve({
            ok: false,
            status_code: res.statusCode,
            latency_ms: Date.now() - started,
            error: 'non_json_health',
          });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', latency_ms: Date.now() - started });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

function proxyToBrain(req, res, endpointOverride) {
  const started = Date.now();
  const requestId = req.headers['x-request-id'] || activityLog.newRequestId();
  const endpoint = endpointOverride || req.path || '/';

  res.setHeader('x-request-id', requestId);

  let url;
  try {
    const pathPart = String(endpoint).startsWith('/') ? endpoint : `/${endpoint}`;
    url = new URL(pathPart, `${BRAIN_BASE}/`);
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'brain_proxy_misconfigured',
      detail: err.message,
      brain_endpoint: BRAIN_BASE,
      request_id: requestId,
    });
  }

  for (const [k, v] of Object.entries(req.query || {})) {
    url.searchParams.set(k, v);
  }

  const bodyStr = req.method === 'POST' && req.body ? JSON.stringify(req.body) : null;
  const headers = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': req.ip || '',
    'X-Request-Id': requestId,
    'X-Console-Source': 'om-brain-console',
  };
  if (SERVICE_TOKEN) headers.Authorization = `Bearer ${SERVICE_TOKEN}`;
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  const upstream = http.request(url, { method: req.method, headers, timeout: 120000 }, (upRes) => {
    const chunks = [];
    upRes.on('data', (chunk) => chunks.push(chunk));
    upRes.on('end', () => {
      const body = Buffer.concat(chunks);
      const latencyMs = Date.now() - started;
      const statusCode = upRes.statusCode || 502;
      const bodyText = body.toString('utf8');

      res.status(statusCode);
      for (const h of ['content-type', 'cache-control', 'x-request-id']) {
        if (upRes.headers[h]) res.setHeader(h, upRes.headers[h]);
      }
      res.setHeader('x-request-id', requestId);
      res.end(body);

      activityLog.logBrainActivity({
        requestId,
        endpoint,
        method: req.method,
        statusCode,
        latencyMs,
        userRole: 'console',
        errorSummary: statusCode >= 400 ? summarizeProxyError(statusCode, bodyText) : null,
      });
    });
  });

  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.status(504).json({ ok: false, error: 'brain_timeout', request_id: requestId });
    }
    activityLog.logBrainActivity({
      requestId,
      endpoint,
      method: req.method,
      statusCode: 504,
      latencyMs: Date.now() - started,
      outcome: 'error',
      errorSummary: 'timeout',
    });
  });

  upstream.on('error', (err) => {
    const latencyMs = Date.now() - started;
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: 'brain_unavailable',
        detail: err.message,
        request_id: requestId,
      });
    }
    activityLog.logBrainActivity({
      requestId,
      endpoint,
      method: req.method,
      statusCode: 502,
      latencyMs,
      outcome: 'error',
      errorSummary: err.message,
    });
  });

  if (bodyStr) upstream.write(bodyStr);
  upstream.end();
}

app.get('/health', async (_req, res) => {
  const brain = await probeBrainHealth();
  res.json({
    ok: true,
    service: 'om-brain-console',
    host: HOST,
    port: PORT,
    brain_upstream: BRAIN_BASE,
    brain_reachable: brain.ok === true,
    brain_probe: brain,
    auth_mode: CONSOLE_AUTH_TOKEN ? 'bearer_token' : 'lan_trust',
  });
});

const brainRouter = express.Router();

brainRouter.get('/proxy-health', (_req, res) => {
  res.json({
    ok: true,
    service: 'om-brain-console-proxy',
    brain_endpoint: BRAIN_BASE,
    fleet_environment: 'om-dev-254',
    google_places_configured: null,
    host: '192.168.1.254',
    note: 'Local console proxy on om-dev — not OMAI',
  });
});

brainRouter.get('/activity', (req, res) => {
  const limit = req.query?.limit;
  const data = activityLog.listBrainActivity(limit);
  res.json({ ok: true, source: 'console', ...data });
});

brainRouter.get('/console/briefing', async (_req, res) => {
  try {
    const briefing = await buildBriefing();
    res.json(briefing);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'briefing_synthesis_failed',
      detail: err && err.message,
      generated_at: new Date().toISOString(),
      overall_state: 'unknown',
    });
  }
});

brainRouter.get('/omai-activity', async (req, res) => {
  try {
    const data = await fetchOmaiProxyActivity(req.query.limit);
    res.json({ ok: true, source: 'omai', ...data });
  } catch (err) {
    res.json({
      ok: false,
      source: 'omai',
      unavailable: true,
      message: 'OMAI proxy activity unavailable',
      detail: err.message,
      activity: [],
    });
  }
});

brainRouter.get('/events', (req, res) => proxyToBrain(req, res, '/audit/findings'));
brainRouter.get('*', (req, res) => proxyToBrain(req, res));
brainRouter.post('*', (req, res) => proxyToBrain(req, res));

app.use('/api/brain', consoleAuth, brainRouter);

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false }));
  app.get('*', consoleAuth, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text/plain').send('om-brain-console: build web/dist then restart service');
  });
}

app.listen(PORT, HOST, () => {
  console.log(`[om-brain-console] listening on http://${HOST}:${PORT}`);
  console.log(`[om-brain-console] brain upstream ${BRAIN_BASE}`);
  console.log(`[om-brain-console] auth ${CONSOLE_AUTH_TOKEN ? 'bearer token required' : 'LAN trust (nginx allowlist)'}`);
});
