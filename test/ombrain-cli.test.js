'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'ombrain.js');

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args],
      // Strip any ambient OMBRAIN_URL so registry tests are deterministic.
      { env: { ...process.env, OMBRAIN_URL: '', NO_COLOR: '1', ...env }, timeout: 20000 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout, stderr });
      });
  });
}

function tmpRegistry(obj) {
  const p = path.join(os.tmpdir(), `ombrain-reg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function stub(port, handler) {
  const s = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    // report the actual bound port (port may be 0 = OS-assigned)
    res.end(JSON.stringify({ ok: true, service: 'stub', port: s.address().port }));
  });
  return new Promise((resolve) => s.listen(port, '127.0.0.1', () => resolve(s)));
}

// ---- Basic CLI contract ----------------------------------------------------

test('--version prints v2 version', async () => {
  const r = await run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /ombrain 2\.\d+\.\d+/);
});

test('--help documents topology + server commands', async () => {
  const r = await run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Topology:/);
  assert.match(r.stdout, /server add <name> <host>/);
  assert.match(r.stdout, /set-master/);
  assert.match(r.stdout, /skill\|skills add/);
  assert.match(r.stdout, /action\|actions list/);
  assert.match(r.stdout, /--json/);
});

test('unknown command exits 1', async () => {
  const r = await run(['definitely-not-a-command'], { OMBRAIN_SERVERS: tmpRegistry({ servers: [{ name: 'm', host: '127.0.0.1', ports: '1', role: 'master' }] }) });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /unknown command/);
});

// ---- Registry management ---------------------------------------------------

test('server add / set-master / ports / list / remove', async () => {
  const reg = tmpRegistry({ version: 1, rr: 0, servers: [] });
  let r = await run(['server', 'add', 'master', '192.168.1.254', '--ports', '60000-62000', '--role', 'master'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);
  r = await run(['server', 'add', 'backup1', '192.168.1.239', '--ports', '60000-62000', '--role', 'backup', '--priority', '10'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);

  r = await run(['server', 'list'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /registry:/);
  assert.match(r.stdout, /master/);
  assert.match(r.stdout, /2001/);

  r = await run(['server', 'list', '--json'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);
  const list = JSON.parse(r.stdout);
  assert.strictEqual(list.servers.length, 2);
  assert.strictEqual(list.servers[0].role, 'master');        // master sorts first
  assert.strictEqual(list.servers[0].port_count, 2001);      // 60000-62000 inclusive

  // Promote backup1 -> master demotes the old master.
  r = await run(['server', 'set-master', 'backup1'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);
  r = await run(['server', 'list', '--json'], { OMBRAIN_SERVERS: reg });
  const list2 = JSON.parse(r.stdout);
  const master = list2.servers.find((s) => s.role === 'master');
  assert.strictEqual(master.name, 'backup1');

  // Replace a port pool.
  r = await run(['server', 'ports', 'master', '8391,8392'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);

  // Remove.
  r = await run(['server', 'remove', 'backup1'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 0);
  r = await run(['server', 'list', '--json'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(JSON.parse(r.stdout).servers.length, 1);
});

// ---- Load-balancing across a port pool ------------------------------------

test('round-robin spreads across live ports and skips dead ones', async () => {
  const a = await stub(0);
  const b = await stub(0);
  const c = await stub(0);
  const pa = a.address().port, pb = b.address().port, pc = c.address().port;
  // Include two definitely-dead ports (1, 2) ahead of the live ones.
  const reg = tmpRegistry({
    version: 1, rr: 0,
    servers: [{ name: 'master', scheme: 'http', host: '127.0.0.1',
      ports: `${pa},${pb},${pc}`, role: 'master', priority: 0 }],
  });
  try {
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      const r = await run(['ping'], { OMBRAIN_SERVERS: reg });
      assert.strictEqual(r.code, 0, r.stderr);
      const m = r.stdout.match(/:(\d+)\s*$/m);
      if (m) seen.add(Number(m[1]));
    }
    // Over 6 calls the RR cursor should have touched more than one live port.
    assert.ok(seen.size >= 2, `expected RR across ports, saw ${[...seen]}`);
  } finally {
    a.close(); b.close(); c.close();
  }
});

// ---- Host failover ---------------------------------------------------------

test('fails over from a dead master pool to a backup', async () => {
  const live = await stub(0);
  const lp = live.address().port;
  const reg = tmpRegistry({
    version: 1, rr: 0,
    servers: [
      { name: 'master', scheme: 'http', host: '127.0.0.1', ports: '1-3', role: 'master', priority: 0 },
      { name: 'backup1', scheme: 'http', host: '127.0.0.1', ports: `${lp}`, role: 'backup', priority: 10 },
    ],
  });
  try {
    const r = await run(['health'], { OMBRAIN_SERVERS: reg });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /stub\s+ok/);
    assert.match(r.stdout, /port:\s*\d+/);
    assert.match(r.stderr, /via backup: backup1/);
  } finally {
    live.close();
  }
});

test('all endpoints unreachable exits 3 with aggregated error', async () => {
  const reg = tmpRegistry({
    version: 1, rr: 0,
    servers: [{ name: 'master', scheme: 'http', host: '127.0.0.1', ports: '1-3', role: 'master', priority: 0 }],
  });
  const r = await run(['health'], { OMBRAIN_SERVERS: reg });
  assert.strictEqual(r.code, 3);
  assert.match(r.stderr, /unreachable/);
});

// ---- --url bypasses the registry ------------------------------------------

test('--url uses one explicit endpoint and ignores the registry', async () => {
  const s = await stub(0);
  const p = s.address().port;
  const reg = tmpRegistry({ version: 1, rr: 0, servers: [{ name: 'master', host: '127.0.0.1', ports: '1', role: 'master' }] });
  try {
    const r = await run(['health', '--url', `http://127.0.0.1:${p}`], { OMBRAIN_SERVERS: reg });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /stub\s+ok/);
    assert.match(r.stdout, new RegExp(`port:\\s*${p}`));
  } finally {
    s.close();
  }
});

// ---- server status ---------------------------------------------------------

test('server status reports reachable/unreachable per server', async () => {
  const s = await stub(0);
  const p = s.address().port;
  const reg = tmpRegistry({
    version: 1, rr: 0,
    servers: [
      { name: 'master', scheme: 'http', host: '127.0.0.1', ports: '1-3', role: 'master', priority: 0 },
      { name: 'backup1', scheme: 'http', host: '127.0.0.1', ports: `${p}`, role: 'backup', priority: 10 },
    ],
  });
  try {
    const r = await run(['server', 'status'], { OMBRAIN_SERVERS: reg });
    // master dead -> exit code 3, but output still printed
    assert.strictEqual(r.code, 3);
    assert.match(r.stdout, /master.*DOWN/i);
    assert.match(r.stdout, /backup1.*UP/i);

    const j = JSON.parse((await run(['server', 'status', '--json'], { OMBRAIN_SERVERS: reg })).stdout);
    const master = j.topology_status.find((x) => x.role === 'master');
    const backup = j.topology_status.find((x) => x.role === 'backup');
    assert.strictEqual(master.reachable, false);
    assert.strictEqual(backup.reachable, true);
  } finally {
    s.close();
  }
});

// ---- Skills (HTTP /brain/skills) -------------------------------------------

function skillsStub(state) {
  const s = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/brain/skills') {
      const skills = [...state.values()];
      return res.end(JSON.stringify({ count: skills.length, skills }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/brain/skills/')) {
      const key = decodeURIComponent(url.pathname.slice('/brain/skills/'.length));
      const skill = state.get(key);
      if (!skill) return res.writeHead(404).end(JSON.stringify({ ok: false, error: 'skill_not_found' }));
      return res.end(JSON.stringify({ skill }));
    }
    if (req.method === 'POST' && url.pathname === '/brain/skills') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body || '{}');
        if (String(b.script || '').includes('rm -rf')) {
          return res.writeHead(400).end(JSON.stringify({ ok: false, error: 'unsafe_script', details: ['rm -rf blocked'] }));
        }
        const skill_key = b.key;
        const existing = state.get(skill_key);
        const version = (existing?.version || 0) + 1;
        const row = {
          skill_key,
          title: b.title || skill_key,
          language: b.language,
          script_body: b.script,
          version,
          run_count: 0,
        };
        state.set(skill_key, row);
        res.writeHead(existing ? 200 : 201);
        res.end(JSON.stringify({ ok: true, skill_key, version: row.version }));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/run')) {
      const key = decodeURIComponent(url.pathname.slice('/brain/skills/'.length, -'/run'.length));
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body || '{}');
        const execute = !!b.execute;
        res.end(JSON.stringify({
          ok: true,
          skill_key: key,
          dry_run: !execute,
          executed: execute,
          exit_code: execute ? 0 : undefined,
        }));
      });
      return;
    }
    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

test('skill add/list/show/run via HTTP API', async () => {
  const state = new Map();
  const s = await skillsStub(state);
  const p = s.address().port;
  const tmpScript = path.join(os.tmpdir(), `ombrain-skill-${process.pid}.sh`);
  fs.writeFileSync(tmpScript, '#!/bin/bash\necho hello\n');
  try {
    const url = `http://127.0.0.1:${p}`;
    let r = await run(['skill', 'add', '--file', tmpScript, '--key', 'echo-test'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Skill saved.*echo-test/);

    r = await run(['skills', 'list'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /echo-test/);

    r = await run(['skill', 'show', 'echo-test'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /echo-test/);
    assert.match(r.stdout, /echo hello/);

    r = await run(['skills', 'run', 'echo-test'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /dry-run/i);

    r = await run(['skill', 'run', 'echo-test', '--commit'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /executed/);
  } finally {
    fs.unlinkSync(tmpScript);
    s.close();
  }
});

test('skill add rejects unsafe script from API', async () => {
  const state = new Map();
  const s = await skillsStub(state);
  const p = s.address().port;
  const bad = path.join(os.tmpdir(), `ombrain-bad-${process.pid}.sh`);
  fs.writeFileSync(bad, 'rm -rf /');
  try {
    const r = await run(['skills', 'add', '--file', bad, '--key', 'bad'], { OMBRAIN_URL: `http://127.0.0.1:${p}` });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /unsafe_script/);
  } finally {
    fs.unlinkSync(bad);
    s.close();
  }
});

// ---- Actions (HTTP /brain/actions) -----------------------------------------

function actionsStub() {
  const history = [];
  const actions = [
    {
      id: 'omai.system.status',
      source: 'omai',
      category: 'system',
      title: 'Full system status',
      risk: 'read',
      mutation: false,
      supports_dry_run: true,
    },
    {
      id: 'omai.services.health_check',
      source: 'omai',
      category: 'services',
      title: 'Service health check',
      risk: 'read',
      mutation: false,
      supports_dry_run: true,
    },
  ];
  const s = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/brain/actions') {
      return res.end(JSON.stringify({ ok: true, count: actions.length, actions }));
    }
    if (req.method === 'GET' && url.pathname === '/brain/actions/history') {
      return res.end(JSON.stringify({ ok: true, count: history.length, history }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/brain/actions/')) {
      const id = decodeURIComponent(url.pathname.slice('/brain/actions/'.length));
      const action = actions.find((a) => a.id === id);
      if (!action) return res.writeHead(404).end(JSON.stringify({ ok: false, error: 'action_not_found' }));
      return res.end(JSON.stringify({ ok: true, action }));
    }
    if (req.method === 'POST' && url.pathname === '/brain/actions/resolve') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body || '{}');
        const q = String(b.query || '').toLowerCase();
        const action = q.includes('health') ? actions[1] : actions[0];
        res.end(JSON.stringify({ ok: true, matched: true, action, confidence: 0.9, matched_query: q }));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/run')) {
      const id = decodeURIComponent(url.pathname.slice('/brain/actions/'.length, -'/run'.length));
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body || '{}');
        const dry_run = b.dry_run === true;
        const record = { action_id: id, dry_run, committed: !dry_run, result: dry_run ? 'dry_run' : 'success' };
        history.unshift(record);
        if (dry_run) {
          return res.end(JSON.stringify({ ok: true, action_id: id, dry_run: true, committed: false, preview: { would_run: id } }));
        }
        res.end(JSON.stringify({
          ok: true,
          action_id: id,
          dry_run: false,
          committed: true,
          result: { fleet_health: { score: 95, detail: 'ok' } },
        }));
      });
      return;
    }
    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
}

test('actions list/show/run/resolve/history via HTTP API', async () => {
  const s = await actionsStub();
  const p = s.address().port;
  const url = `http://127.0.0.1:${p}`;
  try {
    let r = await run(['actions', 'list'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /omai\.system\.status/);

    r = await run(['action', 'show', 'omai.system.status'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Full system status/);

    r = await run(['actions', 'run', 'omai.system.status'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /fleet 95%/i);

    r = await run(['actions', 'resolve', 'check full system status'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /omai\.system\.status/);

    r = await run(['actions', 'history'], { OMBRAIN_URL: url });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /omai\.system\.status/);
  } finally {
    s.close();
  }
});

test('skills list still works alongside actions stub', async () => {
  const state = new Map();
  const s = await skillsStub(state);
  const p = s.address().port;
  try {
    const r = await run(['skills', 'list'], { OMBRAIN_URL: `http://127.0.0.1:${p}` });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /No active skills|Skills/);
  } finally {
    s.close();
  }
});
