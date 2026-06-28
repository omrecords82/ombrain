'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'ombrain.js');

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 15000 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout, stderr });
      });
  });
}

test('ombrain --version prints the version', async () => {
  const r = await run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /ombrain \d+\.\d+\.\d+/);
});

test('ombrain --help lists core commands', async () => {
  const r = await run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /ask <query/);
  assert.match(r.stdout, /pascha <year>/);
  assert.match(r.stdout, /saints <month> <day>/);
});

test('no args prints help and exits 0', async () => {
  const r = await run([]);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Usage:/);
});

test('unknown command exits 1 with an error', async () => {
  const r = await run(['definitely-not-a-command']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /unknown command/);
});

test('unreachable host exits 3 with a tunnel hint', async () => {
  // Port 1 is privileged/unused -> connection refused.
  const r = await run(['health', '--url', 'http://127.0.0.1:1']);
  assert.strictEqual(r.code, 3);
  assert.match(r.stderr, /cannot reach Brain/);
  assert.match(r.stderr, /tunnel|--url/);
});

test('happy path: talks to a stub server and prints JSON', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'om-brain-stub' }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await run(['health'], { OMBRAIN_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /om-brain-stub/);

    // ping returns 0 on healthy
    const p = await run(['ping'], { OMBRAIN_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(p.code, 0);
    assert.match(p.stdout, /ok/);
  } finally {
    server.close();
  }
});

test('server 4xx surfaces as a non-zero exit with the error code', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'year_out_of_range', hint: '1900-2200' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await run(['year', '1234'], { OMBRAIN_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /year_out_of_range/);
  } finally {
    server.close();
  }
});
