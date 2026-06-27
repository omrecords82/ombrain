'use strict';

/**
 * P1 smoke tests — 2026-06-27
 * Run: cd /var/www/omai/om-brain && npm test -- --test-name-pattern "P1"
 */

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/api/server');
const { Orchestrator } = require('../src/orchestrator/orchestrator');
const { BtwQueue } = require('../src/session/btwQueue');

function makeStubDb(overrides = {}) {
  return {
    backend: 'stub',
    allSystemTruth: () => [],
    listKnowledge: () => [],
    getKnowledgeBySlug: () => null,
    upsertKnowledge: () => {},
    searchKnowledge: (q) => (q.includes('auth') || q.includes('OMAI')
      ? [{ slug: 'auth-config', title: 'Auth Config', body: 'Auth configuration details', category: 'ops', source_ref: 'auth-config' }]
      : []),
    listProcedures: () => [],
    getProcedureBySlug: () => null,
    upsertProcedure: () => {},
    approveProcedure: () => {},
    rejectProcedure: () => {},
    incrementProcedureUsage: () => {},
    listCorrections: () => [],
    appendCorrection: () => {},
    correctionsByQuestionType: () => [],
    correctionsForDecision: () => [],
    reviseCorrection: () => null,
    listTasks: () => [],
    upsertTask: () => {},
    updateTaskStatus: () => {},
    listDecisions: () => [],
    appendDecision: () => 'test-decision-id',
    upsertWorkSession: () => {},
    searchTheology: () => [],
    getTheologyByRef: () => null,
    theologyTopics: () => [],
    theologySources: () => [],
    scriptureByRef: () => [],
    searchChurches: () => [],
    upsertChurch: () => {},
    churchByPlaceId: () => null,
    listChurchJurisdictions: () => ['OCA', 'GOARCH', 'ROCOR'],
    enrichChurch: () => {},
    pendingBtw: () => [],
    enqueueBtw: () => {},
    markBtwDelivered: () => {},
    enqueueBtwQuestion: () => {},
    pendingBtwQuestions: () => [],
    answerBtw: () => {},
    btwHistory: () => [],
    ...overrides,
  };
}

test('P1 smoke — ask routes knowledge via modeRouter', async () => {
  const db = makeStubDb();
  const modeRouter = {
    classifyIntent: (q) => (q.toLowerCase().includes('pascha') ? 'knowledge' : 'ops'),
    routeQuery: async () => ({ answer: 'Pascha 2027 is April 18', mode: 'knowledge' }),
  };
  const orch = new Orchestrator({ db, modeRouter });
  const result = await orch.ask('when is Pascha 2027', { sessionId: 'test-sess-1' });
  assert.strictEqual(result.mode, 'knowledge');
});

test('P1 smoke — ask routes ops via diagnose', async () => {
  const db = makeStubDb();
  const modeRouter = {
    classifyIntent: () => 'ops',
    routeQuery: async () => { throw new Error('should not be called for ops'); },
  };
  const orch = new Orchestrator({ db, modeRouter });
  const result = await orch.ask('should I restart the OMAI service', { sessionId: 'test-sess-2' });
  assert.strictEqual(result.mode, 'ops');
  assert.ok(result.recommendation);
  assert.strictEqual(result.executed, false);
});

test('P1 smoke — ask btw enqueue', async () => {
  const db = makeStubDb();
  const btwQueue = new BtwQueue({ db });
  const orch = new Orchestrator({ db, btwQueue });
  const result = await orch.ask('what is the Nicene Creed', {
    sessionId: 'test-sess-btw',
    btw: true,
  });
  assert.strictEqual(result.ok, true);
  assert.ok(result.btw_id);
  assert.strictEqual(result.queued, true);
});

test('P1 smoke — ask defaults to ops without modeRouter', async () => {
  const db = makeStubDb();
  const orch = new Orchestrator({ db });
  const result = await orch.ask('some question', { sessionId: 'test-sess-3' });
  assert.strictEqual(result.mode, 'general');
});

test('P1 smoke — _recallSystemTruth merges knowledge_memory', () => {
  const db = makeStubDb({
    allSystemTruth: () => [{ domain: 'OMAI', fact_key: 'omai-host', body: 'OMAI runs on 192.168.1.239', source_ref: 'arch' }],
    searchKnowledge: () => [{ slug: 'auth-config', title: 'Auth Config', body: 'Keycloak auth on .254', category: 'ops', source_ref: 'auth-config', confidence: 1.0 }],
  });
  const orch = new Orchestrator({ db });
  const recalled = orch._recallSystemTruth('OMAI');
  const sources = recalled.map((r) => r.recall_source);
  assert.ok(sources.includes('system_truth_memory'));
  assert.ok(sources.includes('knowledge_memory'));
});

test('P1 smoke — BtwQueue enqueue', () => {
  const enqueued = [];
  const db = makeStubDb({
    enqueueBtwQuestion: (opts) => { enqueued.push(opts); return opts.btw_id; },
  });
  const q = new BtwQueue({ db });
  const result = q.enqueue({ session_id: 'sess-1', question: 'what is Theosis?', mode: 'knowledge' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(enqueued.length, 1);
});

test('P1 smoke — POST /brain/churches/find 503 without churchFinder', (t, done) => {
  const http = require('http');
  const db = makeStubDb();
  const app = createServer({ db, orchestrator: null, churchFinder: null });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/brain/churches/find', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      assert.strictEqual(res.statusCode, 503);
      server.close(done);
    });
    req.write(JSON.stringify({ query: 'Orthodox church near New York' }));
    req.end();
  });
});

test('P1 smoke — GET /brain/churches/jurisdictions', (t, done) => {
  const http = require('http');
  const db = makeStubDb();
  const app = createServer({ db, orchestrator: null, churchFinder: null });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    http.get({ hostname: '127.0.0.1', port, path: '/brain/churches/jurisdictions' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const json = JSON.parse(data);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(json.jurisdictions));
        server.close(done);
      });
    });
  });
});

test('P1 smoke — POST /brain/ask 400 without query', (t, done) => {
  const http = require('http');
  const db = makeStubDb();
  const orch = new Orchestrator({ db });
  const app = createServer({ db, orchestrator: orch });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/brain/ask', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      assert.strictEqual(res.statusCode, 400);
      server.close(done);
    });
    req.write(JSON.stringify({}));
    req.end();
  });
});

test('P1 smoke — POST /brain/ask returns mode', (t, done) => {
  const http = require('http');
  const db = makeStubDb();
  const orch = new Orchestrator({ db });
  const app = createServer({ db, orchestrator: orch });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/brain/ask', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        assert.strictEqual(res.statusCode, 200);
        const json = JSON.parse(data);
        assert.ok(json.mode);
        server.close(done);
      });
    });
    req.write(JSON.stringify({ query: 'should I restart OMAI?' }));
    req.end();
  });
});
