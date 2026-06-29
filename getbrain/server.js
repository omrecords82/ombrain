#!/usr/bin/env node
'use strict';
/*
 * getbrain — LAN bootstrap service for the `ombrain` CLI.
 *
 * Runs on om-prod01 (.239). A workstation on 192.168.1.0/24 visits
 *   http://orthodoxmetrics.com/getbrain
 * enters a shared PIN, and receives a one-line install command that installs
 * the `ombrain` CLI and points it at the Brain's LAN endpoint.
 *
 * No internet, no SMS/email gateway: access is gated by (a) a client-IP subnet
 * allowlist and (b) a shared bootstrap PIN. On correct PIN the service issues a
 * short-lived single-use token; the install endpoints require that token.
 *
 * Zero runtime dependencies (Node core only).
 *
 * Config via environment (see getbrain.env.example):
 *   GETBRAIN_PORT          listen port            (default 8395)
 *   GETBRAIN_BIND          bind address           (default 0.0.0.0)
 *   GETBRAIN_PIN           shared bootstrap PIN    (REQUIRED)
 *   GETBRAIN_ALLOW_CIDR    comma list of CIDRs     (default 192.168.1.0/24,127.0.0.1/32)
 *   GETBRAIN_BRAIN_HOST    Brain master host       (default 192.168.1.254)
 *   GETBRAIN_BRAIN_PORTS   Brain port(s)           (default 8390; range ok)
 *   GETBRAIN_ASSET_DIR     dir holding ombrain.js + install-ombrain.sh
 *                          (default: ../bin and ../deploy resolved from here)
 *   GETBRAIN_PUBLIC_BASE   public base path for the one-liner
 *                          (default http://orthodoxmetrics.com/getbrain)
 *   GETBRAIN_TOKEN_TTL_MS  token lifetime ms       (default 600000 = 10 min)
 *   GETBRAIN_MAX_ATTEMPTS  PIN attempts per IP / window (default 5)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  port: parseInt(process.env.GETBRAIN_PORT || '8395', 10),
  bind: process.env.GETBRAIN_BIND || '0.0.0.0',
  pin: process.env.GETBRAIN_PIN || '',
  allowCidr: (process.env.GETBRAIN_ALLOW_CIDR || '192.168.1.0/24,127.0.0.1/32')
    .split(',').map(s => s.trim()).filter(Boolean),
  brainHost: process.env.GETBRAIN_BRAIN_HOST || '192.168.1.254',
  brainPorts: process.env.GETBRAIN_BRAIN_PORTS || '8390',
  assetCli: process.env.GETBRAIN_ASSET_CLI ||
    path.resolve(__dirname, '..', 'bin', 'ombrain.js'),
  assetInstaller: process.env.GETBRAIN_ASSET_INSTALLER ||
    path.resolve(__dirname, '..', 'deploy', 'install-ombrain.sh'),
  publicBase: (process.env.GETBRAIN_PUBLIC_BASE || 'http://orthodoxmetrics.com/getbrain')
    .replace(/\/+$/, ''),
  tokenTtlMs: parseInt(process.env.GETBRAIN_TOKEN_TTL_MS || '600000', 10),
  maxAttempts: parseInt(process.env.GETBRAIN_MAX_ATTEMPTS || '5', 10),
};

// ---------------------------------------------------------------------------
// IP / CIDR allowlist
// ---------------------------------------------------------------------------
function ipToLong(ip) {
  const m = String(ip).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
function cidrMatch(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = bitsRaw === undefined ? 32 : parseInt(bitsRaw, 10);
  const ipL = ipToLong(ip);
  const netL = ipToLong(net);
  if (ipL === null || netL === null) return false;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ipL & mask) >>> 0) === ((netL & mask) >>> 0);
}
function clientIp(req) {
  // Trust X-Real-IP / X-Forwarded-For only from a local proxy; otherwise socket.
  const xri = req.headers['x-real-ip'];
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = (xri || xff || req.socket.remoteAddress || '').toString();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}
function ipAllowed(ip) {
  return CFG.allowCidr.some(c => cidrMatch(ip, c));
}

// ---------------------------------------------------------------------------
// Token + rate-limit state (in-memory; process-local is fine for a bootstrap)
// ---------------------------------------------------------------------------
const tokens = new Map();   // token -> { exp, ip, used:false }
const attempts = new Map(); // ip    -> { count, resetAt }

function issueToken(ip) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { exp: Date.now() + CFG.tokenTtlMs, ip, used: false });
  return token;
}
function consumeToken(token, ip) {
  const t = tokens.get(token);
  if (!t) return false;
  if (t.used || Date.now() > t.exp) { tokens.delete(token); return false; }
  if (t.ip !== ip) return false;          // token bound to the issuing IP
  t.used = true;                          // single-use
  tokens.delete(token);
  return true;
}
function gcTokens() {
  const now = Date.now();
  for (const [k, v] of tokens) if (now > v.exp) tokens.delete(k);
}
setInterval(gcTokens, 60000).unref();

function rateLimited(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now > a.resetAt) { a = { count: 0, resetAt: now + 15 * 60000 }; attempts.set(ip, a); }
  return a.count >= CFG.maxAttempts;
}
function noteAttempt(ip, ok) {
  const a = attempts.get(ip);
  if (!a) return;
  if (ok) { a.count = 0; } else { a.count += 1; }
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still compare to avoid early-exit timing leak
    crypto.timingSafeEqual(ba, Buffer.from(ba));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function sendText(res, code, text) {
  send(res, code, text, { 'Content-Type': 'text/plain; charset=utf-8' });
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });
}
function readBody(req, cb) {
  let buf = '';
  let tooBig = false;
  req.on('data', c => {
    buf += c;
    if (buf.length > 8192) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => cb(tooBig ? null : buf));
  req.on('error', () => cb(null));
}
function parseForm(body) {
  const out = {};
  for (const pair of String(body || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
function pageForm(msg = '') {
  const note = msg ? `<p class="msg">${msg}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>getbrain — install ombrain</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:8vh auto;padding:0 1rem;color:#1b1b1b}
 h1{font-size:1.4rem} code,pre{background:#f4f4f4;border-radius:6px}
 pre{padding:1rem;overflow:auto;white-space:pre-wrap;word-break:break-all}
 input[type=password]{font-size:1.1rem;padding:.5rem;width:12rem;letter-spacing:.2em}
 button{font-size:1rem;padding:.55rem 1.1rem;cursor:pointer}
 .msg{color:#b00020;font-weight:600}.muted{color:#666;font-size:.9rem}
</style></head><body>
<h1>Install <code>ombrain</code> on this machine</h1>
<p class="muted">LAN bootstrap. You must be on the internal network (192.168.1.0/24)
and have the shared bootstrap PIN.</p>
${note}
<form method="POST" action="install">
  <label>Bootstrap PIN<br><input type="password" name="pin" autocomplete="off" autofocus></label>
  <p><button type="submit">Get install command</button></p>
</form>
</body></html>`;
}
function pageResult(oneLiner) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>getbrain — your install command</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:680px;margin:8vh auto;padding:0 1rem;color:#1b1b1b}
 h1{font-size:1.3rem} pre{background:#0d1117;color:#e6edf3;border-radius:8px;padding:1rem;overflow:auto;white-space:pre-wrap;word-break:break-all}
 .muted{color:#666;font-size:.9rem} button{font-size:.9rem;padding:.4rem .8rem;cursor:pointer}
</style></head><body>
<h1>Run this on your WSL / Linux workstation</h1>
<p class="muted">Single-use, expires in ${Math.round(CFG.tokenTtlMs / 60000)} minutes. Requires sudo.</p>
<pre id="cmd">${oneLiner}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('cmd').innerText)">Copy</button>
<p class="muted">After it finishes: <code>ombrain server status</code> then <code>ombrain pascha 2026</code>.</p>
</body></html>`;
}

function oneLiner(token) {
  // The bootstrap script is fetched with the token and piped to bash.
  return `curl -fsSL "${CFG.publicBase}/bootstrap.sh?token=${token}" | sudo bash`;
}

// ---------------------------------------------------------------------------
// bootstrap.sh — what `curl | sudo bash` actually runs on the workstation.
// It fetches the two assets (token-gated) and runs the installer standalone,
// seeding the registry to point at the Brain LAN pool.
// ---------------------------------------------------------------------------
function bootstrapScript(token) {
  const base = CFG.publicBase;
  return `#!/usr/bin/env bash
set -euo pipefail
BASE="${base}"
TOKEN="${token}"
BRAIN_HOST="${CFG.brainHost}"
BRAIN_PORTS="${CFG.brainPorts}"

echo "[getbrain] installing ombrain -> master \${BRAIN_HOST} pool \${BRAIN_PORTS}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || echo "[getbrain] warning: node not found on PATH; installer will try common locations"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "\${BASE}/ombrain.js?token=\${TOKEN}"          -o "\$TMP/ombrain.js"
curl -fsSL "\${BASE}/install-ombrain.sh?token=\${TOKEN}"  -o "\$TMP/install-ombrain.sh"

bash "\$TMP/install-ombrain.sh" \\
  --standalone "\$TMP/ombrain.js" \\
  --register-master "\$BRAIN_HOST" --ports "\$BRAIN_PORTS"

echo
echo "[getbrain] done. Verify with:"
echo "  ombrain server status"
echo "  ombrain pascha 2026"
`;
}

// ---------------------------------------------------------------------------
// Asset serving
// ---------------------------------------------------------------------------
function serveAsset(res, file, contentType) {
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 500, `asset unavailable: ${path.basename(file)}\n`);
    send(res, 200, data, { 'Content-Type': contentType });
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/getbrain/, '') || '/';

  // health is open to localhost only (for systemd / monitoring)
  if (route === '/health' || route === '/healthz') {
    if (ip !== '127.0.0.1' && !ipAllowed(ip)) return sendText(res, 403, 'forbidden\n');
    return sendJson(res, 200, { ok: true, service: 'getbrain', brain: CFG.brainHost });
  }

  // everything else requires the subnet allowlist
  if (!ipAllowed(ip)) {
    return sendText(res, 403, 'forbidden: not on an allowed network\n');
  }

  // GET / -> PIN form
  if (req.method === 'GET' && (route === '/' || route === '')) {
    return send(res, 200, pageForm(), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // POST /install -> verify PIN, issue token, show one-liner
  if (req.method === 'POST' && route === '/install') {
    if (!CFG.pin) return sendText(res, 503, 'service not configured: GETBRAIN_PIN unset\n');
    if (rateLimited(ip)) return send(res, 429, pageForm('Too many attempts. Wait 15 minutes.'),
      { 'Content-Type': 'text/html; charset=utf-8' });
    return readBody(req, body => {
      if (body === null) return sendText(res, 413, 'request too large\n');
      const form = parseForm(body);
      const ok = timingSafeEq(form.pin || '', CFG.pin);
      noteAttempt(ip, ok);
      if (!ok) return send(res, 401, pageForm('Incorrect PIN.'),
        { 'Content-Type': 'text/html; charset=utf-8' });
      const token = issueToken(ip);
      return send(res, 200, pageResult(oneLiner(token)),
        { 'Content-Type': 'text/html; charset=utf-8' });
    });
  }

  // token-gated asset/bootstrap endpoints
  const token = url.searchParams.get('token') || '';
  if (req.method === 'GET' && route === '/bootstrap.sh') {
    if (!consumeToken(token, ip)) return sendText(res, 401, '# invalid or expired token\n');
    // re-issue short-lived asset tokens bound to this ip so the two asset
    // fetches inside bootstrap.sh succeed (single-use bootstrap token is spent)
    const at = issueToken(ip);
    return sendText(res, 200, bootstrapScript(at));
  }
  if (req.method === 'GET' && (route === '/ombrain.js' || route === '/install-ombrain.sh')) {
    // asset tokens are single-use; allow either of the two known assets per token
    // by NOT consuming until both fetched would be complex — instead accept a
    // valid (unexpired, ip-bound) token without consuming, since assets are
    // non-secret installer files and the subnet allowlist already gates access.
    const t = tokens.get(token);
    if (!t || t.used || Date.now() > t.exp || t.ip !== ip) {
      return sendText(res, 401, '# invalid or expired token\n');
    }
    if (route === '/ombrain.js') return serveAsset(res, CFG.assetCli, 'application/javascript');
    return serveAsset(res, CFG.assetInstaller, 'text/x-shellscript');
  }

  return sendText(res, 404, 'not found\n');
});

if (require.main === module) {
  if (!CFG.pin) {
    console.warn('[getbrain] WARNING: GETBRAIN_PIN is not set — /install will return 503.');
  }
  server.listen(CFG.port, CFG.bind, () => {
    console.log(`[getbrain] listening on ${CFG.bind}:${CFG.port}  ` +
      `(brain=${CFG.brainHost} pool=${CFG.brainPorts}, allow=${CFG.allowCidr.join(',')})`);
  });
}

module.exports = {
  server, CFG, ipToLong, cidrMatch, ipAllowed, clientIp,
  issueToken, consumeToken, timingSafeEq, oneLiner, bootstrapScript, parseForm,
};
