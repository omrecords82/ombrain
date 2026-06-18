'use strict';

/**
 * Data-access layer for the five memory layers (Spec v1.1 §5).
 *
 * Persistence strategy:
 *   - Preferred: better-sqlite3 (embedded SQLite), with sqlite-vec when present.
 *   - Fallback:  a pure-JS, file-backed JSON store implementing the SAME API so
 *               the package runs and tests pass even when no native SQLite
 *               binary can be built in the sandbox.
 *
 * The append-only guarantee for decision_memory is enforced in BOTH backends.
 * All writes that may contain telemetry are expected to be PRE-REDACTED by the
 * caller; this layer additionally never exposes a raw UPDATE/DELETE on the
 * decision ledger.
 */

const fs = require('fs');
const path = require('path');
const vec = require('./vectorStore');

const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'db', 'schema.sql');

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
function tryLoadSqlite() {
  try {
    // eslint-disable-next-line global-require
    return require('better-sqlite3');
  } catch (_) {
    return null;
  }
}

class MemoryDB {
  /**
   * @param {object} opts { dbPath, embeddingDim }
   */
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || './data/brain.db';
    this.embeddingDim = opts.embeddingDim || 768;
    this.backend = null; // 'sqlite' | 'json'
    this.sqlite = null;
    this.json = null;
    this.vecAvailable = false;
  }

  init() {
    const Sqlite = tryLoadSqlite();
    if (Sqlite) {
      this._initSqlite(Sqlite);
    } else {
      this._initJson();
    }
    return this;
  }

  _ensureDir() {
    const dir = path.dirname(this.dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _initSqlite(Sqlite) {
    this._ensureDir();
    this.sqlite = new Sqlite(this.dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    this.sqlite.exec(schema);
    // Probe sqlite-vec (optional acceleration). The pure-JS path remains the
    // portable fallback regardless of this result.
    const probe = vec.probeSqliteVec();
    this.vecAvailable = probe.available;
    if (probe.available) {
      try {
        // eslint-disable-next-line global-require
        const sqliteVec = require('sqlite-vec');
        sqliteVec.load(this.sqlite);
        this.sqlite.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS doctrine_vec USING vec0(embedding float[${this.embeddingDim}]);`,
        );
      } catch (_) {
        this.vecAvailable = false;
      }
    }
    this.backend = 'sqlite';
  }

  _initJson() {
    this._ensureDir();
    this.backend = 'json';
    this.vecAvailable = false;
    const base = {
      doctrine_memory: [],
      system_truth_memory: [],
      event_memory: [],
      work_memory: [],
      decision_memory: [],
      _seq: { doctrine: 0, systruth: 0, event: 0, work: 0, decision: 0 },
    };
    if (fs.existsSync(this.dbPath + '.json')) {
      try {
        this.json = JSON.parse(fs.readFileSync(this.dbPath + '.json', 'utf8'));
      } catch (_) {
        this.json = base;
      }
    } else {
      this.json = base;
    }
  }

  _persistJson() {
    if (this.backend === 'json') {
      fs.writeFileSync(this.dbPath + '.json', JSON.stringify(this.json, null, 2));
    }
  }

  backendName() {
    return this.backend + (this.vecAvailable ? '+sqlite-vec' : ' (pure-JS cosine fallback)');
  }

  // -------------------------------------------------------------------------
  // Doctrine memory
  // -------------------------------------------------------------------------
  insertDoctrine({ rule_key, title, body, source_ref, embedding }) {
    const blob = embedding ? vec.encodeVector(embedding) : null;
    if (this.backend === 'sqlite') {
      const stmt = this.sqlite.prepare(
        `INSERT INTO doctrine_memory (rule_key, title, body, source_ref, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const r = stmt.run(rule_key, title, body, source_ref, blob);
      return r.lastInsertRowid;
    }
    const id = ++this.json._seq.doctrine;
    this.json.doctrine_memory.push({ id, rule_key, title, body, source_ref, embedding: embedding || null });
    this._persistJson();
    return id;
  }

  allDoctrine() {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM doctrine_memory').all();
    }
    return this.json.doctrine_memory.slice();
  }

  // -------------------------------------------------------------------------
  // System-truth memory (upsert by domain+fact_key)
  // -------------------------------------------------------------------------
  upsertSystemTruth({ domain, fact_key, body, source_ref, embedding }) {
    const blob = embedding ? vec.encodeVector(embedding) : null;
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO system_truth_memory (domain, fact_key, body, source_ref, embedding)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(domain, fact_key) DO UPDATE SET
             body=excluded.body, source_ref=excluded.source_ref,
             embedding=excluded.embedding, refreshed_at=datetime('now')`,
        )
        .run(domain, fact_key, body, source_ref, blob);
      return;
    }
    const existing = this.json.system_truth_memory.find(
      (r) => r.domain === domain && r.fact_key === fact_key,
    );
    if (existing) {
      Object.assign(existing, { body, source_ref, embedding: embedding || null });
    } else {
      this.json.system_truth_memory.push({
        id: ++this.json._seq.systruth,
        domain,
        fact_key,
        body,
        source_ref,
        embedding: embedding || null,
      });
    }
    this._persistJson();
  }

  systemTruthByDomain(domain) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM system_truth_memory WHERE domain = ?').all(domain);
    }
    return this.json.system_truth_memory.filter((r) => r.domain === domain);
  }

  allSystemTruth() {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM system_truth_memory').all();
    }
    return this.json.system_truth_memory.slice();
  }

  // -------------------------------------------------------------------------
  // Event memory (rolling window)
  // -------------------------------------------------------------------------
  insertEvent({ source, event_type, severity, church_id, correlation, payload_json }) {
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO event_memory (source, event_type, severity, church_id, correlation, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(source, event_type || null, severity || null, church_id || null, correlation || null, payload_json);
      return;
    }
    this.json.event_memory.push({
      id: ++this.json._seq.event,
      source,
      event_type: event_type || null,
      severity: severity || null,
      church_id: church_id || null,
      correlation: correlation || null,
      payload_json,
      observed_at: new Date().toISOString(),
    });
    this._persistJson();
  }

  recentEvents(limit = 50) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM event_memory ORDER BY id DESC LIMIT ?').all(limit);
    }
    return this.json.event_memory.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Work memory
  // -------------------------------------------------------------------------
  upsertWorkSession({ session_id, work_item_ref, incident_tier, state, context_json }) {
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO work_memory (session_id, work_item_ref, incident_tier, state, context_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             work_item_ref=excluded.work_item_ref, incident_tier=excluded.incident_tier,
             state=excluded.state, context_json=excluded.context_json, updated_at=datetime('now')`,
        )
        .run(session_id, work_item_ref || null, incident_tier || null, state, context_json);
      return;
    }
    const existing = this.json.work_memory.find((r) => r.session_id === session_id);
    if (existing) {
      Object.assign(existing, { work_item_ref, incident_tier, state, context_json, updated_at: new Date().toISOString() });
    } else {
      this.json.work_memory.push({
        id: ++this.json._seq.work,
        session_id,
        work_item_ref: work_item_ref || null,
        incident_tier: incident_tier || null,
        state,
        context_json,
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    this._persistJson();
  }

  // -------------------------------------------------------------------------
  // Decision memory (APPEND-ONLY)
  // -------------------------------------------------------------------------
  appendDecision(entry) {
    const {
      session_id,
      classification,
      recommendation,
      rationale,
      doctrine_rule,
      owning_system,
      verification_steps,
      model_advisory,
      requires_omstudio,
    } = entry;
    if (this.backend === 'sqlite') {
      const r = this.sqlite
        .prepare(
          `INSERT INTO decision_memory
             (session_id, classification, recommendation, rationale, doctrine_rule,
              owning_system, verification_steps, model_advisory, requires_omstudio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session_id || null,
          classification,
          recommendation,
          rationale,
          doctrine_rule,
          owning_system || null,
          verification_steps || null,
          model_advisory || null,
          requires_omstudio ? 1 : 0,
        );
      return r.lastInsertRowid;
    }
    const id = ++this.json._seq.decision;
    this.json.decision_memory.push({
      id,
      session_id: session_id || null,
      classification,
      recommendation,
      rationale,
      doctrine_rule,
      owning_system: owning_system || null,
      verification_steps: verification_steps || null,
      model_advisory: model_advisory || null,
      requires_omstudio: requires_omstudio ? 1 : 0,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
    return id;
  }

  listDecisions(limit = 100) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM decision_memory ORDER BY id DESC LIMIT ?').all(limit);
    }
    return this.json.decision_memory.slice(-limit).reverse();
  }

  close() {
    if (this.backend === 'sqlite' && this.sqlite) this.sqlite.close();
    if (this.backend === 'json') this._persistJson();
  }
}

module.exports = { MemoryDB };
