'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Configure the service via env BEFORE requiring it.
process.env.GETBRAIN_PIN = 'test-pin-1234';
process.env.GETBRAIN_ALLOW_CIDR = '192.168.1.0/24,127.0.0.1/32';
process.env.GETBRAIN_BRAIN_HOST = '192.168.1.254';
process.env.GETBRAIN_BRAIN_PORTS = '60000-62000';
process.env.GETBRAIN_PUBLIC_BASE = 'http://orthodoxmetrics.com/getbrain';

const gb = require('../getbrain/server.js');

// --- pure helpers ----------------------------------------------------------
test('cidrMatch: subnet membership', () => {
  assert.equal(gb.cidrMatch('192.168.1.50', '192.168.1.0/24'), true);
  assert.equal(gb.cidrMatch('192.168.2.50', '192.168.1.0/24'), false);
  assert.equal(gb.cidrMatch('127.0.0.1', '127.0.0.1/32'), true);
  assert.equal(gb.cidrMatch('10.0.0.1', '192.168.1.0/24'), false);
});

test('ipAllowed honors the allowlist', () => {
  assert.equal(gb.ipAllowed('192.168.1.99'), true);
  assert.equal(gb.ipAllowed('192.168.5.99'), false);
});

test('token: single-use and ip-bound', () => {
  const tok = gb.issueToken('192.168.1.7');
  assert.equal(gb.consumeToken(tok, '192.168.1.8'), false); // wrong ip
  assert.equal(gb.consumeToken(tok, '192.168.1.7'), true);  // ok
  assert.equal(gb.consumeToken(tok, '192.168.1.7'), false); // already used
});

test('timingSafeEq', () => {
  assert.equal(gb.timingSafeEq('abc', 'abc'), true);
  assert.equal(gb.timingSafeEq('abc', 'abd'), false);
  assert.equal(gb.timingSafeEq('abc', 'abcd'), false);
});

test('oneLiner + bootstrapScript carry config', () => {
  const ol = gb.oneLiner('TOK');
  assert.match(ol, /curl -fsSL "http:\/\/orthodoxmetrics\.com\/getbrain\/bootstrap\.sh\?token=TOK" \| sudo bash/);
  const bs = gb.bootstrapScript('TOK2');
  assert.match(bs, /BRAIN_HOST="192\.168\.1\.254"/);
  assert.match(bs, /BRAIN_PORTS="60000-62000"/);
  assert.match(bs, /--register-master "\$BRAIN_HOST" --ports "\$BRAIN_PORTS"/);
});

// --- end-to-end over HTTP ---------------------------------------------------
function listen() {
  return new Promise(resolve => {
    gb.server.listen(0, '127.0.0.1', () => resolve(gb.server.address().port));
  });
}
function req(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path,
      headers: Object.assign({ 'X-Real-IP': '192.168.1.50' }, headers || {}) }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('e2e: health, PIN gate, token flow, asset gating', async () => {
  const port = await listen();
  try {
    // health (allowed subnet)
    const h = await req(port, 'GET', '/getbrain/health');
    assert.equal(h.status, 200);
    assert.match(h.body, /"ok":true/);

    // forbidden from outside subnet
    const f = await req(port, 'GET', '/getbrain/', { headers: { 'X-Real-IP': '10.1.1.1' } });
    assert.equal(f.status, 403);

    // GET form
    const form = await req(port, 'GET', '/getbrain/');
    assert.equal(form.status, 200);
    assert.match(form.body, /Bootstrap PIN/);

    // wrong PIN -> 401
    const bad = await req(port, 'POST', '/getbrain/install',
      { body: 'pin=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(bad.status, 401);

    // correct PIN -> 200 + one-liner with a token
    const ok = await req(port, 'POST', '/getbrain/install',
      { body: 'pin=test-pin-1234', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(ok.status, 200);
    const m = ok.body.match(/bootstrap\.sh\?token=([0-9a-f]+)/);
    assert.ok(m, 'one-liner contains a token');
    const token = m[1];

    // bootstrap.sh with the token -> shell script that re-issues an asset token
    const bs = await req(port, 'GET', `/getbrain/bootstrap.sh?token=${token}`);
    assert.equal(bs.status, 200);
    assert.match(bs.body, /install-ombrain\.sh/);
    const am = bs.body.match(/TOKEN="([0-9a-f]+)"/);
    assert.ok(am, 'bootstrap carries an asset token');
    const assetTok = am[1];

    // asset fetch with the asset token
    const cli = await req(port, 'GET', `/getbrain/ombrain.js?token=${assetTok}`);
    assert.equal(cli.status, 200);
    assert.match(cli.body, /ombrain/);

    const inst = await req(port, 'GET', `/getbrain/install-ombrain.sh?token=${assetTok}`);
    assert.equal(inst.status, 200);
    assert.match(inst.body, /install-ombrain/);

    // reused bootstrap token (already consumed) -> 401
    const reuse = await req(port, 'GET', `/getbrain/bootstrap.sh?token=${token}`);
    assert.equal(reuse.status, 401);

    // bogus token -> 401
    const bogus = await req(port, 'GET', `/getbrain/ombrain.js?token=deadbeef`);
    assert.equal(bogus.status, 401);
  } finally {
    gb.server.close();
  }
});
