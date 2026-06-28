'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { MemoryDB } = require('../src/memory/db');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bugfix-'));
  return new MemoryDB({ dbPath: path.join(dir, 'brain.db'), embeddingDim: 8 }).init();
}

function baseDecision(session_id, classification) {
  return {
    session_id,
    classification,
    recommendation: 'rec',
    rationale: 'why',
    doctrine_rule: 'OM-DOCTRINE-0001',
    owning_system: 'OMAI',
  };
}

// ---------------------------------------------------------------------------
// BUG 1 — listDecisions must accept BOTH a numeric limit and an options object.
// ---------------------------------------------------------------------------

test('listDecisions(number) returns recent decisions (legacy contract preserved)', () => {
  const db = freshDb();
  db.appendDecision(baseDecision('s1', 'informational'));
  db.appendDecision(baseDecision('s2', 'informational'));
  const rows = db.listDecisions(10);
  assert.strictEqual(rows.length, 2);
  db.close();
});

test('listDecisions({session_id, limit}) filters by session', () => {
  const db = freshDb();
  db.appendDecision(baseDecision('alpha', 'service_restart_recommendation'));
  db.appendDecision(baseDecision('alpha', 'service_restart_recommendation'));
  db.appendDecision(baseDecision('beta', 'informational'));

  const alpha = db.listDecisions({ session_id: 'alpha', limit: 5 });
  assert.strictEqual(alpha.length, 2, 'only alpha decisions are returned');
  assert.ok(alpha.every((d) => d.session_id === 'alpha'));

  const beta = db.listDecisions({ session_id: 'beta', limit: 5 });
  assert.strictEqual(beta.length, 1);
  db.close();
});

test('listDecisions object form respects the limit', () => {
  const db = freshDb();
  for (let i = 0; i < 6; i += 1) {
    db.appendDecision(baseDecision('g', 'informational'));
  }
  const rows = db.listDecisions({ session_id: 'g', limit: 3 });
  assert.strictEqual(rows.length, 3);
  db.close();
});

// ---------------------------------------------------------------------------
// BUG 2 — reviseCorrection must not be ABORTed by the append-only UPDATE guard,
//          and must leave the guard in place afterwards.
// ---------------------------------------------------------------------------

test('reviseCorrection supersedes without being blocked by the append-only trigger', () => {
  const db = freshDb();
  const origId = db.insertCorrection({
    source_decision_id: 'd1',
    session_id: 's1',
    question_type: 'service_restart_recommendation',
    verdict: 'incorrect',
    original_output: 'restart immediately',
    correction: 'never auto-restart; escalate to superadmin',
    correction_source: 'operator_override',
  });

  const newId = db.reviseCorrection(origId, {
    correction: 'escalate to superadmin via OMStudio first',
    verdict: 'partially_correct',
  });

  assert.ok(newId, 'a new correction id is returned');
  assert.notStrictEqual(newId, origId);

  // Old row is now inactive, new row is active v2.
  const all = db.listCorrections({ limit: 50 });
  const oldRow = all.find((r) => r.id === origId);
  const newRow = all.find((r) => r.id === newId);
  assert.strictEqual(oldRow.active, 0, 'old correction is superseded (active=0)');
  assert.strictEqual(newRow.active, 1, 'new correction is active');
  assert.strictEqual(newRow.correction_version, 2);
  assert.strictEqual(newRow.verdict, 'partially_correct');
  db.close();
});

test('append-only UPDATE guard is restored after reviseCorrection', () => {
  const db = freshDb();
  const origId = db.insertCorrection({
    source_decision_id: 'd2',
    session_id: 's2',
    question_type: 'other',
    verdict: 'incorrect',
    original_output: 'x',
    correction: 'y',
    correction_source: 'operator_override',
  });
  db.reviseCorrection(origId, { correction: 'z', verdict: 'incorrect' });

  // A raw UPDATE must still be ABORTed by the restored trigger.
  assert.throws(
    () => db.sqlite.prepare('UPDATE correction_memory SET wrong_answer = ? WHERE id = ?').run('tampered', origId),
    /append-only/i,
    'the no_update trigger is back in force',
  );
  db.close();
});

test('reviseCorrection returns null for an unknown id and leaves the guard intact', () => {
  const db = freshDb();
  const result = db.reviseCorrection('does-not-exist', { correction: 'c', verdict: 'incorrect' });
  assert.strictEqual(result, null);
  // Insert one row, then confirm UPDATE is still blocked.
  const id = db.insertCorrection({
    source_decision_id: 'd3', session_id: 's3', question_type: 'other',
    verdict: 'incorrect', original_output: 'a', correction: 'b', correction_source: 'operator_override',
  });
  assert.throws(
    () => db.sqlite.prepare('UPDATE correction_memory SET wrong_answer = ? WHERE id = ?').run('t', id),
    /append-only/i,
  );
  db.close();
});
