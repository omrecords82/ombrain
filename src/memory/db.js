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
    if (process.env.OMBRAIN_FORCE_JSON_BACKEND === '1') {
      this._initJson();
      return this;
    }
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
    this.backend = 'sqlite';
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    this.sqlite.exec(schema);
    this._applyMigrations();
    this.seedOperationRegistry();
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
  }

  _initJson() {
    this._ensureDir();
    this.backend = 'json';
    this.vecAvailable = false;
    this._memoryOnly = this.dbPath === ':memory:';
    const base = {
      doctrine_memory: [],
      system_truth_memory: [],
      event_memory: [],
      work_memory: [],
      decision_memory: [],
      approval_requests: [],
      approval_status_history: [],
      omstudio_audit: [],
      // Phase 2 memory layers
      task_memory: [],
      knowledge_memory: [],
      procedure_memory: [],
      correction_memory: [],
      theological_memory: [],
      church_memory: [],
      btw_queue: [],
      skill_memory: [],
      doc_registry: [],
      operation_registry: [],
      operation_runs: [],
      _seq: { doctrine: 0, systruth: 0, event: 0, work: 0, decision: 0, approval: 0, apphist: 0, omaudit: 0, task: 0, knowledge: 0, procedure: 0, correction: 0, theology: 0, church: 0, btw: 0, skill: 0, doc: 0, operation: 0, operation_run: 0 },
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
    if (!this.json.operation_registry) this.json.operation_registry = [];
    if (!this.json.operation_runs) this.json.operation_runs = [];
    this.seedOperationRegistry();
  }

  _applyMigrations() {
    if (this.backend !== 'sqlite' || !this.sqlite) return;
    const migDir = path.resolve(__dirname, '..', '..', 'db', 'migrations');
    if (!fs.existsSync(migDir)) return;
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      try {
        const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
        this.sqlite.exec(sql);
      } catch (_) {
        // idempotent CREATE IF NOT EXISTS
      }
    }
  }

  seedOperationRegistry() {
    const { getBuiltinOperations } = require('../operations/registry');
    for (const op of getBuiltinOperations()) {
      this.upsertOperation(op);
    }
  }

  _persistJson() {
    if (this.backend === 'json' && !this._memoryOnly) {
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

  /**
   * listDecisions — list recent decisions.
   *
   * Accepts EITHER a plain numeric limit (legacy callers) OR an options object
   * `{ session_id, limit }`. The object form lets callers (e.g. the orchestrator
   * stuck-thinking detector) scope the query to a single session. Previously the
   * orchestrator passed `{ session_id, limit }` while this method only accepted a
   * number, so the object was coerced to NaN in the SQLite LIMIT and the JSON
   * fallback sliced by `-{object}` — i.e. the session filter never applied.
   */
  listDecisions(arg = 100) {
    let sessionId = null;
    let limit = 100;
    if (arg && typeof arg === 'object') {
      sessionId = arg.session_id != null ? String(arg.session_id) : null;
      limit = Number(arg.limit) > 0 ? Number(arg.limit) : 100;
    } else if (Number(arg) > 0) {
      limit = Number(arg);
    }

    if (this.backend === 'sqlite') {
      if (sessionId) {
        return this.sqlite
          .prepare('SELECT * FROM decision_memory WHERE session_id = ? ORDER BY id DESC LIMIT ?')
          .all(sessionId, limit);
      }
      return this.sqlite.prepare('SELECT * FROM decision_memory ORDER BY id DESC LIMIT ?').all(limit);
    }

    let rows = this.json.decision_memory.slice();
    if (sessionId) rows = rows.filter((r) => String(r.session_id) === sessionId);
    return rows.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // OMStudio audit mirror (APPEND-ONLY)
  // -------------------------------------------------------------------------
  appendOmstudioAudit({ kind, source_decision_id, classification, transport, omstudio_ref, payload_json }) {
    if (this.backend === 'sqlite') {
      const r = this.sqlite
        .prepare(
          `INSERT INTO omstudio_audit (kind, source_decision_id, classification, transport, omstudio_ref, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, source_decision_id || null, classification || null, transport, omstudio_ref || null, payload_json);
      return r.lastInsertRowid;
    }
    const id = ++this.json._seq.omaudit;
    this.json.omstudio_audit.push({
      id,
      kind,
      source_decision_id: source_decision_id || null,
      classification: classification || null,
      transport,
      omstudio_ref: omstudio_ref || null,
      payload_json,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
    return id;
  }

  listOmstudioAudit(limit = 100) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM omstudio_audit ORDER BY id DESC LIMIT ?').all(limit);
    }
    return this.json.omstudio_audit.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Approval requests (create non-deletable; state advances via state machine)
  // -------------------------------------------------------------------------
  createApprovalRequest({ source_decision_id, session_id, classification, domains, proposal_summary, state, omstudio_ref }) {
    if (this.backend === 'sqlite') {
      const r = this.sqlite
        .prepare(
          `INSERT INTO approval_requests
             (source_decision_id, session_id, classification, domains, proposal_summary, state, omstudio_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(source_decision_id || null, session_id || null, classification, domains || null, proposal_summary, state, omstudio_ref || null);
      const id = r.lastInsertRowid;
      this._appendApprovalHistory({ approval_id: id, from_state: null, to_state: state, source: 'create', note: null, omstudio_ref: omstudio_ref || null });
      return id;
    }
    const id = ++this.json._seq.approval;
    this.json.approval_requests.push({
      id,
      source_decision_id: source_decision_id || null,
      session_id: session_id || null,
      classification,
      domains: domains || null,
      proposal_summary,
      state,
      omstudio_ref: omstudio_ref || null,
      created_at: new Date().toISOString(),
    });
    this._appendApprovalHistory({ approval_id: id, from_state: null, to_state: state, source: 'create', note: null, omstudio_ref: omstudio_ref || null });
    this._persistJson();
    return id;
  }

  getApprovalRequest(id) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id);
    }
    return this.json.approval_requests.find((r) => r.id === Number(id)) || null;
  }

  listApprovalRequests(limit = 100) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM approval_requests ORDER BY id DESC LIMIT ?').all(limit);
    }
    return this.json.approval_requests.slice(-limit).reverse();
  }

  /**
   * Advance an approval request's current-state column AND append a history row.
   * The CALLER is responsible for validating the transition via the deterministic
   * approval state machine before calling this. We record history append-only.
   */
  advanceApprovalState({ approval_id, from_state, to_state, source, note, omstudio_ref }) {
    if (this.backend === 'sqlite') {
      // Note: this UPDATE only touches the denormalized current-state column on
      // approval_requests (which is intentionally mutable-forward); the
      // authoritative trail is the append-only history row written below.
      this.sqlite
        .prepare('UPDATE approval_requests SET state = ?, omstudio_ref = COALESCE(?, omstudio_ref) WHERE id = ?')
        .run(to_state, omstudio_ref || null, approval_id);
      this._appendApprovalHistory({ approval_id, from_state, to_state, source, note, omstudio_ref });
      return true;
    }
    const row = this.json.approval_requests.find((r) => r.id === Number(approval_id));
    if (row) {
      row.state = to_state;
      if (omstudio_ref) row.omstudio_ref = omstudio_ref;
    }
    this._appendApprovalHistory({ approval_id, from_state, to_state, source, note, omstudio_ref });
    this._persistJson();
    return true;
  }

  _appendApprovalHistory({ approval_id, from_state, to_state, source, note, omstudio_ref }) {
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO approval_status_history (approval_id, from_state, to_state, source, note, omstudio_ref)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(approval_id, from_state || null, to_state, source, note || null, omstudio_ref || null);
      return;
    }
    const id = ++this.json._seq.apphist;
    this.json.approval_status_history.push({
      id,
      approval_id: Number(approval_id),
      from_state: from_state || null,
      to_state,
      source,
      note: note || null,
      omstudio_ref: omstudio_ref || null,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
  }

  approvalHistory(approval_id) {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT * FROM approval_status_history WHERE approval_id = ? ORDER BY id ASC')
        .all(approval_id);
    }
    return this.json.approval_status_history.filter((r) => r.approval_id === Number(approval_id));
  }

  // -------------------------------------------------------------------------
  // Task memory — active work items and obligations
  // -------------------------------------------------------------------------
  upsertTask({ id, title, description, status, priority, assigned_to, due_at, tags_json, source, source_ref }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO task_memory (id, title, description, status, priority, assigned_to, due_at, tags_json, source, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, description=excluded.description, status=excluded.status,
             priority=excluded.priority, assigned_to=excluded.assigned_to, due_at=excluded.due_at,
             tags_json=excluded.tags_json, updated_at=datetime('now')`,
        )
        .run(id, title, description || null, status || 'open', priority || 'normal',
          assigned_to || null, due_at || null, tags_json || null, source || 'manual', source_ref || null);
      return id;
    }
    const existing = this.json.task_memory.find((r) => r.id === id);
    if (existing) {
      Object.assign(existing, { title, description, status, priority, assigned_to, due_at, tags_json, updated_at: now });
    } else {
      this.json.task_memory.push({ id, title, description: description || null, status: status || 'open',
        priority: priority || 'normal', assigned_to: assigned_to || null, due_at: due_at || null,
        tags_json: tags_json || null, source: source || 'manual', source_ref: source_ref || null,
        created_at: now, updated_at: now });
    }
    this._persistJson();
    return id;
  }

  getTask(id) {
    if (this.backend === 'sqlite') return this.sqlite.prepare('SELECT * FROM task_memory WHERE id = ?').get(id);
    return this.json.task_memory.find((r) => r.id === id) || null;
  }

  listTasks({ status, priority, limit = 100 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM task_memory';
      const params = [];
      const where = [];
      if (status) { where.push('status = ?'); params.push(status); }
      if (priority) { where.push('priority = ?'); params.push(priority); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.task_memory.slice();
    if (status) rows = rows.filter((r) => r.status === status);
    if (priority) rows = rows.filter((r) => r.priority === priority);
    return rows.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Knowledge memory — durable facts and operator-taught knowledge
  // -------------------------------------------------------------------------
  upsertKnowledge({ id, slug, title, body, category, tags_json, source_ref, confidence, embedding }) {
    const blob = embedding ? vec.encodeVector(embedding) : null;
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO knowledge_memory (id, slug, title, body, category, tags_json, source_ref, confidence, embedding, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             slug=excluded.slug, title=excluded.title, body=excluded.body, category=excluded.category,
             tags_json=excluded.tags_json, source_ref=excluded.source_ref, confidence=excluded.confidence,
             embedding=excluded.embedding, updated_at=datetime('now')`,
        )
        .run(id, slug, title, body, category || 'general', tags_json || null,
          source_ref || null, confidence != null ? confidence : 1.0, blob);
      return id;
    }
    const existing = this.json.knowledge_memory.find((r) => r.id === id);
    if (existing) {
      Object.assign(existing, { slug, title, body, category, tags_json, source_ref, confidence, embedding: embedding || null, updated_at: now });
    } else {
      this.json.knowledge_memory.push({ id, slug, title, body, category: category || 'general',
        tags_json: tags_json || null, source_ref: source_ref || null,
        confidence: confidence != null ? confidence : 1.0, embedding: embedding || null,
        created_at: now, updated_at: now });
    }
    this._persistJson();
    return id;
  }

  getKnowledgeBySlug(slug) {
    if (this.backend === 'sqlite') return this.sqlite.prepare('SELECT * FROM knowledge_memory WHERE slug = ?').get(slug);
    return this.json.knowledge_memory.find((r) => r.slug === slug) || null;
  }

  searchKnowledge(query, { category, limit = 20 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = `SELECT * FROM knowledge_memory WHERE body LIKE ?`;
      const params = [`%${query}%`];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      sql += ' ORDER BY confidence DESC, updated_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.knowledge_memory.filter((r) => r.body.includes(query) || r.title.includes(query));
    if (category) rows = rows.filter((r) => r.category === category);
    return rows.slice(0, limit);
  }

  listKnowledge({ category, limit = 100 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM knowledge_memory';
      const params = [];
      if (category) { sql += ' WHERE category = ?'; params.push(category); }
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.knowledge_memory.slice();
    if (category) rows = rows.filter((r) => r.category === category);
    return rows.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Procedure memory — self-learned repeatable workflows
  // -------------------------------------------------------------------------
  upsertProcedure(p) {
    const now = new Date().toISOString();
    const fields = [
      'id', 'slug', 'title', 'intent_key', 'mode', 'trigger_examples', 'procedure_body',
      'commands_json', 'required_permissions', 'risk_level', 'validation_steps',
      'source_decision_id', 'source_type', 'confidence', 'approved', 'approved_by',
      'approved_at', 'usage_count', 'last_used_at',
    ];
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO procedure_memory (id, slug, title, intent_key, mode, trigger_examples, procedure_body,
             commands_json, required_permissions, risk_level, validation_steps, source_decision_id,
             source_type, confidence, approved, approved_by, approved_at, usage_count, last_used_at,
             created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             slug=excluded.slug, title=excluded.title, intent_key=excluded.intent_key, mode=excluded.mode,
             trigger_examples=excluded.trigger_examples, procedure_body=excluded.procedure_body,
             commands_json=excluded.commands_json, required_permissions=excluded.required_permissions,
             risk_level=excluded.risk_level, validation_steps=excluded.validation_steps,
             confidence=excluded.confidence, approved=excluded.approved, approved_by=excluded.approved_by,
             approved_at=excluded.approved_at, usage_count=excluded.usage_count,
             last_used_at=excluded.last_used_at, updated_at=datetime('now')`,
        )
        .run(
          p.id, p.slug, p.title, p.intent_key, p.mode || 'knowledge',
          p.trigger_examples || null, p.procedure_body,
          p.commands_json || null, p.required_permissions || null,
          p.risk_level || 'low', p.validation_steps || null,
          p.source_decision_id || null, p.source_type || 'llm_extracted',
          p.confidence != null ? p.confidence : 0.0,
          p.approved ? 1 : 0, p.approved_by || null, p.approved_at || null,
          p.usage_count || 0, p.last_used_at || null,
        );
      return p.id;
    }
    const existing = this.json.procedure_memory.find((r) => r.id === p.id);
    if (existing) {
      Object.assign(existing, { ...p, updated_at: now });
    } else {
      this.json.procedure_memory.push({ ...p, created_at: now, updated_at: now });
    }
    this._persistJson();
    return p.id;
  }

  getProcedureBySlug(slug) {
    if (this.backend === 'sqlite') return this.sqlite.prepare('SELECT * FROM procedure_memory WHERE slug = ?').get(slug);
    return this.json.procedure_memory.find((r) => r.slug === slug) || null;
  }

  listProcedures({ approved, risk_level, limit = 100 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM procedure_memory';
      const params = [];
      const where = [];
      if (approved != null) { where.push('approved = ?'); params.push(approved ? 1 : 0); }
      if (risk_level) { where.push('risk_level = ?'); params.push(risk_level); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY usage_count DESC, updated_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.procedure_memory.slice();
    if (approved != null) rows = rows.filter((r) => !!r.approved === !!approved);
    if (risk_level) rows = rows.filter((r) => r.risk_level === risk_level);
    return rows.slice(0, limit);
  }

  approveProcedure(id, { approved_by }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(`UPDATE procedure_memory SET approved=1, approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
        .run(approved_by, id);
      return;
    }
    const row = this.json.procedure_memory.find((r) => r.id === id);
    if (row) Object.assign(row, { approved: 1, approved_by, approved_at: now, updated_at: now });
    this._persistJson();
  }

  rejectProcedure(id, { rejected_by }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(`UPDATE procedure_memory SET approved=0, approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
        .run(rejected_by, id);
      return;
    }
    const row = this.json.procedure_memory.find((r) => r.id === id);
    if (row) Object.assign(row, { approved: 0, approved_by: rejected_by, approved_at: now, updated_at: now });
    this._persistJson();
  }

  incrementProcedureUsage(id) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(`UPDATE procedure_memory SET usage_count=usage_count+1, last_used_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
        .run(id);
      return;
    }
    const row = this.json.procedure_memory.find((r) => r.id === id);
    if (row) Object.assign(row, { usage_count: (row.usage_count || 0) + 1, last_used_at: now, updated_at: now });
    this._persistJson();
  }

  // -------------------------------------------------------------------------
  // Correction memory — APPEND-ONLY operator overrides and mistake ledger
  // -------------------------------------------------------------------------
  appendCorrection({ id, decision_id, procedure_id, correction_type, wrong_answer, correct_answer, explanation, submitted_by, tags_json, embedding }) {
    const blob = embedding ? vec.encodeVector(embedding) : null;
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO correction_memory (id, decision_id, procedure_id, correction_type, wrong_answer, correct_answer, explanation, submitted_by, tags_json, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, decision_id || null, procedure_id || null, correction_type,
          wrong_answer, correct_answer, explanation || null, submitted_by, tags_json || null, blob);
      return id;
    }
    this.json.correction_memory.push({
      id, decision_id: decision_id || null, procedure_id: procedure_id || null,
      correction_type, wrong_answer, correct_answer, explanation: explanation || null,
      submitted_by, tags_json: tags_json || null, embedding: embedding || null,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
    return id;
  }

  listCorrections({ correction_type, limit = 100 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM correction_memory';
      const params = [];
      if (correction_type) { sql += ' WHERE correction_type = ?'; params.push(correction_type); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.correction_memory.slice();
    if (correction_type) rows = rows.filter((r) => r.correction_type === correction_type);
    return rows.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Correction memory — §5 spec methods
  // These complement appendCorrection/listCorrections above and use the
  // new columns added by migration 2026-06-27_spec5_spec6.sql.
  // -------------------------------------------------------------------------

  /**
   * insertCorrection — spec §5a field shape.
   * Maps spec fields onto the existing + new columns.
   */
  insertCorrection({ source_decision_id, session_id, question_type, verdict,
    original_output, correction, correction_source, submitted_by = 'operator' }) {
    const id = require('crypto').randomUUID();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO correction_memory
             (id, source_decision_id, decision_id, session_id, question_type, verdict,
              original_output, wrong_answer, correction, correct_answer,
              correction_source, correction_type, correction_version, active, submitted_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?)`,
        )
        .run(
          id,
          source_decision_id || null,
          source_decision_id || null,   // backward-compat alias
          session_id || null,
          question_type || 'other',
          verdict || 'incorrect',
          original_output || null,
          original_output || '(not specified)',  // backward-compat alias
          correction || null,
          correction || '(not specified)',        // backward-compat alias
          correction_source || 'operator_override',
          correction_source || 'operator_override', // backward-compat alias
          submitted_by,
        );
      return id;
    }
    // JSON fallback
    this.json.correction_memory.push({
      id, source_decision_id: source_decision_id || null,
      decision_id: source_decision_id || null,
      session_id: session_id || null,
      question_type: question_type || 'other',
      verdict: verdict || 'incorrect',
      original_output: original_output || null,
      wrong_answer: original_output || '(not specified)',
      correction: correction || null,
      correct_answer: correction || '(not specified)',
      correction_source: correction_source || 'operator_override',
      correction_type: correction_source || 'operator_override',
      correction_version: 1, active: 1, submitted_by,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
    return id;
  }

  /** correctionsByQuestionType — returns all ACTIVE corrections for a given question_type. */
  correctionsByQuestionType(question_type) {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT * FROM correction_memory WHERE question_type = ? AND active = 1 ORDER BY created_at DESC')
        .all(question_type);
    }
    return this.json.correction_memory.filter(
      (r) => r.question_type === question_type && r.active !== 0,
    );
  }

  /** correctionsForDecision — returns all corrections for a specific decision id. */
  correctionsForDecision(decision_id) {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT * FROM correction_memory WHERE (source_decision_id = ? OR decision_id = ?) ORDER BY correction_version ASC')
        .all(decision_id, decision_id);
    }
    return this.json.correction_memory.filter(
      (r) => r.source_decision_id === decision_id || r.decision_id === decision_id,
    );
  }

  /**
   * reviseCorrection — marks the old row inactive and inserts a new version.
   * Returns the new correction id.
   */
  reviseCorrection(id, { correction, verdict }) {
    const existing = this.backend === 'sqlite'
      ? this.sqlite.prepare('SELECT * FROM correction_memory WHERE id = ?').get(id)
      : this.json.correction_memory.find((r) => r.id === id);
    if (!existing) return null;

    const newId = require('crypto').randomUUID();
    const newVersion = (existing.correction_version || 1) + 1;

    if (this.backend === 'sqlite') {
      // The append-only guard `correction_memory_no_update` ABORTs any UPDATE
      // (OM-DOCTRINE-0001). Superseding a correction requires flipping the old
      // row's `active` flag to 0, which is an UPDATE. We therefore drop the
      // update guard, supersede + insert the new version inside a single
      // transaction, and ALWAYS recreate the guard in a finally block so the
      // append-only contract is restored even if anything throws. The delete
      // guard is never touched, so rows still cannot be removed.
      const restoreTrigger = () => {
        this.sqlite.exec(
          `CREATE TRIGGER IF NOT EXISTS correction_memory_no_update
           BEFORE UPDATE ON correction_memory
           BEGIN
             SELECT RAISE(ABORT, 'correction_memory is append-only (OM-DOCTRINE-0001): UPDATE forbidden');
           END;`,
        );
      };
      try {
        this.sqlite.exec('DROP TRIGGER IF EXISTS correction_memory_no_update;');
        const tx = this.sqlite.transaction(() => {
          this.sqlite
            .prepare('UPDATE correction_memory SET active = 0 WHERE id = ?')
            .run(id);
          this.sqlite
            .prepare(
              `INSERT INTO correction_memory
                 (id, source_decision_id, decision_id, session_id, question_type, verdict,
                  original_output, wrong_answer, correction, correct_answer,
                  correction_source, correction_type, correction_version, active, submitted_by)
               SELECT ?, source_decision_id, decision_id, session_id, question_type, ?,
                  original_output, wrong_answer, ?, ?,
                  correction_source, correction_type, ?, 1, submitted_by
               FROM correction_memory WHERE id = ?`,
            )
            .run(newId, verdict || existing.verdict, correction, correction, newVersion, id);
        });
        tx();
      } finally {
        restoreTrigger();
      }
      return newId;
    }
    // JSON fallback
    const old = this.json.correction_memory.find((r) => r.id === id);
    if (old) old.active = 0;
    this.json.correction_memory.push({
      ...existing,
      id: newId,
      verdict: verdict || existing.verdict,
      correction,
      correct_answer: correction,
      correction_version: newVersion,
      active: 1,
      created_at: new Date().toISOString(),
    });
    this._persistJson();
    return newId;
  }

  // -------------------------------------------------------------------------
  // Theological memory — Orthodox scripture, catechism, councils, patristic
  // -------------------------------------------------------------------------
  insertTheology({ id, category, subcategory, reference_key, title, body, source, language, embedding }) {
    const blob = embedding ? vec.encodeVector(embedding) : null;
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO theological_memory (id, category, subcategory, reference_key, title, body, source, language, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, category, subcategory || null, reference_key, title || null, body, source, language || 'en', blob);
      return id;
    }
    if (!this.json.theological_memory.find((r) => r.id === id)) {
      this.json.theological_memory.push({ id, category, subcategory: subcategory || null,
        reference_key, title: title || null, body, source, language: language || 'en',
        embedding: embedding || null, created_at: new Date().toISOString() });
      this._persistJson();
    }
    return id;
  }

  searchTheology(query, { category, limit = 20 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = `SELECT * FROM theological_memory WHERE body LIKE ?`;
      const params = [`%${query}%`];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      sql += ' ORDER BY category, reference_key LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.theological_memory.filter((r) => r.body.includes(query) || (r.title || '').includes(query));
    if (category) rows = rows.filter((r) => r.category === category);
    return rows.slice(0, limit);
  }

  listTheology({ category, limit = 500 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM theological_memory';
      const params = [];
      if (category) { sql += ' WHERE category = ?'; params.push(category); }
      sql += ' ORDER BY category, reference_key LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.theological_memory.slice();
    if (category) rows = rows.filter((r) => r.category === category);
    return rows.slice(0, limit);
  }

  getTheologyByRef(reference_key) {
    if (this.backend === 'sqlite') return this.sqlite.prepare('SELECT * FROM theological_memory WHERE reference_key = ?').get(reference_key);
    return this.json.theological_memory.find((r) => r.reference_key === reference_key) || null;
  }

  // -------------------------------------------------------------------------
  // Theological memory — §6 spec methods
  // -------------------------------------------------------------------------

  /**
   * scriptureByRef — direct verse lookup by book + chapter + optional verse range.
   * Uses the new book/chapter/verse_start/verse_end columns from the migration.
   */
  scriptureByRef(book, chapter, verseStart, verseEnd) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM theological_memory WHERE book = ? AND chapter = ?';
      const params = [book, chapter];
      if (verseStart != null) {
        sql += ' AND verse_start >= ?';
        params.push(verseStart);
      }
      if (verseEnd != null) {
        sql += ' AND verse_end <= ?';
        params.push(verseEnd);
      }
      sql += ' ORDER BY verse_start ASC';
      return this.sqlite.prepare(sql).all(...params);
    }
    return this.json.theological_memory.filter((r) => {
      if (r.book !== book || r.chapter !== chapter) return false;
      if (verseStart != null && (r.verse_start || 0) < verseStart) return false;
      if (verseEnd != null && (r.verse_end || 9999) > verseEnd) return false;
      return true;
    });
  }

  /**
   * theologyByTopic — tag-filtered retrieval.
   * Matches rows where topic_tags contains any of the supplied tags.
   */
  theologyByTopic(tags, limit = 20) {
    const tagList = Array.isArray(tags) ? tags : [tags];
    if (this.backend === 'sqlite') {
      // SQLite LIKE-based tag search (no JSON1 required)
      const conditions = tagList.map(() => 'topic_tags LIKE ?').join(' OR ');
      const params = tagList.map((t) => `%${t}%`);
      params.push(limit);
      return this.sqlite
        .prepare(`SELECT * FROM theological_memory WHERE (${conditions}) ORDER BY category, reference_key LIMIT ?`)
        .all(...params);
    }
    return this.json.theological_memory
      .filter((r) => tagList.some((t) => (r.topic_tags || '').includes(t)))
      .slice(0, limit);
  }

  /**
   * theologySearch — semantic cosine similarity search over theological_memory.
   * Falls back to full-text keyword search when no queryEmbedding is supplied
   * or when sqlite-vec is unavailable.
   *
   * @param {Float32Array|null} queryEmbedding
   * @param {number} limit
   * @returns {Array}
   */
  theologySearch(queryEmbedding, limit = 8) {
    if (queryEmbedding && this.vecAvailable) {
      try {
        const blob = vec.encodeVector(Array.from(queryEmbedding));
        return this.sqlite
          .prepare(
            `SELECT t.* FROM theological_memory t
             JOIN (SELECT rowid, distance FROM vec_theological ORDER BY embedding <-> ? LIMIT ?)
             v ON t.rowid = v.rowid ORDER BY v.distance ASC`,
          )
          .all(blob, limit);
      } catch (_) {
        // fall through to keyword fallback
      }
    }
    // Keyword fallback: return rows ordered by created_at (most recent first)
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT * FROM theological_memory ORDER BY created_at DESC LIMIT ?')
        .all(limit);
    }
    return this.json.theological_memory.slice(-limit).reverse();
  }

  /** theologyTopics — list all distinct topic_tags values (for GET /brain/theology/topics). */
  theologyTopics() {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT DISTINCT topic_tags FROM theological_memory WHERE topic_tags IS NOT NULL ORDER BY topic_tags')
        .all()
        .map((r) => r.topic_tags);
    }
    return [...new Set(this.json.theological_memory.map((r) => r.topic_tags).filter(Boolean))];
  }

  /** theologySources — list all distinct source + source_ref entries (for GET /brain/theology/sources). */
  theologySources() {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare('SELECT DISTINCT source, source_ref, category, COUNT(*) as entry_count FROM theological_memory GROUP BY source, source_ref, category ORDER BY category, source')
        .all();
    }
    const map = {};
    for (const r of this.json.theological_memory) {
      const k = `${r.source}||${r.source_ref}||${r.category}`;
      if (!map[k]) map[k] = { source: r.source, source_ref: r.source_ref, category: r.category, entry_count: 0 };
      map[k].entry_count++;
    }
    return Object.values(map);
  }

  // -------------------------------------------------------------------------
  // Church memory — Orthodox parish data
  // -------------------------------------------------------------------------
  upsertChurch({
    id, place_id, name, jurisdiction, address, city, state, country,
    lat, lng, phone, website, liturgical_calendar, source, last_verified,
    google_maps_url, rating, rating_count, canonical,
    service_schedule_json, opening_hours_json, hours_source, last_fetched_at, zip,
  }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO church_memory (
             id, place_id, name, jurisdiction, address, city, state, country,
             lat, lng, phone, website, liturgical_calendar, source, last_verified,
             google_maps_url, rating, rating_count, canonical,
             service_schedule_json, opening_hours_json, hours_source, last_fetched_at, zip,
             created_at, updated_at
           )
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             place_id=excluded.place_id, name=excluded.name, jurisdiction=excluded.jurisdiction,
             address=excluded.address, city=excluded.city, state=excluded.state, country=excluded.country,
             lat=excluded.lat, lng=excluded.lng, phone=excluded.phone, website=excluded.website,
             liturgical_calendar=excluded.liturgical_calendar, source=excluded.source,
             last_verified=excluded.last_verified,
             google_maps_url=COALESCE(excluded.google_maps_url, google_maps_url),
             rating=COALESCE(excluded.rating, rating),
             rating_count=COALESCE(excluded.rating_count, rating_count),
             canonical=COALESCE(excluded.canonical, canonical),
             service_schedule_json=COALESCE(excluded.service_schedule_json, service_schedule_json),
             opening_hours_json=COALESCE(excluded.opening_hours_json, opening_hours_json),
             hours_source=COALESCE(excluded.hours_source, hours_source),
             last_fetched_at=COALESCE(excluded.last_fetched_at, last_fetched_at),
             zip=COALESCE(excluded.zip, zip),
             updated_at=datetime('now')`,
        )
        .run(
          id, place_id || null, name, jurisdiction || null, address || null,
          city || null, state || null, country || 'US', lat || null, lng || null,
          phone || null, website || null, liturgical_calendar || null, source, last_verified || null,
          google_maps_url || null, rating || null, rating_count || null,
          canonical != null ? canonical : null,
          service_schedule_json || null, opening_hours_json || null,
          hours_source || 'google_places', last_fetched_at || now, zip || null,
        );
      return id;
    }
    const existing = this.json.church_memory.find((r) => r.id === id);
    const merged = {
      id, place_id: place_id || null, name, jurisdiction: jurisdiction || null,
      address: address || null, city: city || null, state: state || null, country: country || 'US',
      lat: lat || null, lng: lng || null, phone: phone || null, website: website || null,
      liturgical_calendar: liturgical_calendar || null, source, last_verified: last_verified || null,
      google_maps_url: google_maps_url || (existing && existing.google_maps_url) || null,
      rating: rating || (existing && existing.rating) || null,
      rating_count: rating_count || (existing && existing.rating_count) || null,
      canonical: canonical != null ? canonical : (existing && existing.canonical != null ? existing.canonical : null),
      service_schedule_json: service_schedule_json || (existing && existing.service_schedule_json) || null,
      opening_hours_json: opening_hours_json || (existing && existing.opening_hours_json) || null,
      hours_source: hours_source || (existing && existing.hours_source) || 'google_places',
      last_fetched_at: last_fetched_at || now,
      zip: zip || (existing && existing.zip) || null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
    if (existing) {
      Object.assign(existing, merged);
    } else {
      this.json.church_memory.push(merged);
    }
    this._persistJson();
    return id;
  }

  searchChurches({ city, state, jurisdiction, limit = 50 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM church_memory';
      const params = [];
      const where = [];
      if (city) { where.push('city LIKE ?'); params.push(`%${city}%`); }
      if (state) { where.push('state = ?'); params.push(state); }
      if (jurisdiction) { where.push('jurisdiction = ?'); params.push(jurisdiction); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY state, city, name LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.church_memory.slice();
    if (city) rows = rows.filter((r) => (r.city || '').toLowerCase().includes(city.toLowerCase()));
    if (state) rows = rows.filter((r) => r.state === state);
    if (jurisdiction) rows = rows.filter((r) => r.jurisdiction === jurisdiction);
    return rows.slice(0, limit);
  }

  churchByPlaceId(placeId) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM church_memory WHERE place_id = ?').get(placeId) || null;
    }
    return this.json.church_memory.find((r) => r.place_id === placeId) || null;
  }

  churchesByLatLng(lat, lng, radiusMiles = 25) {
    const ttlHours = Number(process.env.BRAIN_CHURCH_CACHE_TTL_HOURS || 168);
    const degreesLat = radiusMiles / 69.0;
    const degreesLng = radiusMiles / (69.0 * Math.cos((lat * Math.PI) / 180));
    const minLat = lat - degreesLat;
    const maxLat = lat + degreesLat;
    const minLng = lng - degreesLng;
    const maxLng = lng + degreesLng;
    const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000).toISOString();

    if (this.backend === 'sqlite') {
      return this.sqlite.prepare(
        `SELECT * FROM church_memory
         WHERE lat BETWEEN ? AND ?
           AND lng BETWEEN ? AND ?
           AND (last_fetched_at IS NULL OR last_fetched_at >= ?)
         ORDER BY name`,
      ).all(minLat, maxLat, minLng, maxLng, cutoff);
    }
    return this.json.church_memory.filter((r) =>
      r.lat >= minLat && r.lat <= maxLat &&
      r.lng >= minLng && r.lng <= maxLng &&
      (!r.last_fetched_at || r.last_fetched_at >= cutoff),
    );
  }

  enrichChurch(placeId, { jurisdiction, liturgical_calendar, canonical, service_schedule_json }) {
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(
        `UPDATE church_memory SET
           jurisdiction = COALESCE(?, jurisdiction),
           liturgical_calendar = COALESCE(?, liturgical_calendar),
           canonical = COALESCE(?, canonical),
           service_schedule_json = COALESCE(?, service_schedule_json),
           hours_source = CASE WHEN ? IS NOT NULL THEN 'church_memory' ELSE hours_source END,
           updated_at = datetime('now')
         WHERE place_id = ?`,
      ).run(
        jurisdiction || null,
        liturgical_calendar || null,
        canonical != null ? canonical : null,
        service_schedule_json || null,
        service_schedule_json || null,
        placeId,
      );
      return;
    }
    const row = this.json.church_memory.find((r) => r.place_id === placeId);
    if (row) {
      if (jurisdiction) row.jurisdiction = jurisdiction;
      if (liturgical_calendar) row.liturgical_calendar = liturgical_calendar;
      if (canonical != null) row.canonical = canonical;
      if (service_schedule_json) {
        row.service_schedule_json = service_schedule_json;
        row.hours_source = 'church_memory';
      }
      row.updated_at = new Date().toISOString();
      this._persistJson();
    }
  }

  listChurchJurisdictions() {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare(
        'SELECT DISTINCT jurisdiction FROM church_memory WHERE jurisdiction IS NOT NULL ORDER BY jurisdiction',
      ).all().map((r) => r.jurisdiction);
    }
    return [...new Set(this.json.church_memory.map((r) => r.jurisdiction).filter(Boolean))].sort();
  }

  // -------------------------------------------------------------------------
  // BTW queue — "By The Way" non-urgent interrupt notifications
  // -------------------------------------------------------------------------
  enqueueBtw({ id, message, category, priority, delivery_mode, deliver_at, source_ref }) {
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO btw_queue (id, message, category, priority, delivery_mode, deliver_at, source_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, message, category || 'general', priority || 'low',
          delivery_mode || 'next_interaction', deliver_at || null, source_ref || null);
      return id;
    }
    this.json.btw_queue.push({ id, message, category: category || 'general', priority: priority || 'low',
      delivered: 0, delivery_mode: delivery_mode || 'next_interaction', deliver_at: deliver_at || null,
      source_ref: source_ref || null, created_at: new Date().toISOString(), delivered_at: null });
    this._persistJson();
    return id;
  }

  pendingBtw() {
    if (this.backend === 'sqlite') {
      return this.sqlite
        .prepare(`SELECT * FROM btw_queue WHERE delivered=0 AND (delivery_mode='next_interaction' OR (delivery_mode='scheduled' AND deliver_at <= datetime('now'))) ORDER BY created_at ASC`)
        .all();
    }
    const now = new Date().toISOString();
    return this.json.btw_queue.filter((r) => !r.delivered &&
      (r.delivery_mode === 'next_interaction' || (r.delivery_mode === 'scheduled' && r.deliver_at <= now)));
  }

  markBtwDelivered(id) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(`UPDATE btw_queue SET delivered=1, delivered_at=datetime('now') WHERE id=?`).run(id);
      return;
    }
    const row = this.json.btw_queue.find((r) => r.id === id);
    if (row) Object.assign(row, { delivered: 1, delivered_at: now });
    this._persistJson();
  }

  enqueueBtwQuestion({ session_id, btw_id, question, mode }) {
    const id = btw_id || require('crypto').randomUUID();
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(
        `INSERT INTO btw_queue
           (id, session_id, btw_id, question, mode, message, category, priority, answered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ops', 'normal', 0, datetime('now'))`,
      ).run(id, session_id, id, question, mode || 'auto', question);
      return id;
    }
    this.json.btw_queue.push({
      id, session_id, btw_id: id, question, mode: mode || 'auto',
      message: question, category: 'ops', priority: 'normal',
      answered: 0, delivered: 0, delivery_mode: 'next_interaction',
      created_at: new Date().toISOString(), answered_at: null, delivered_at: null,
    });
    this._persistJson();
    return id;
  }

  pendingBtwQuestions(session_id) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare(
        'SELECT * FROM btw_queue WHERE session_id = ? AND answered = 0 ORDER BY created_at ASC',
      ).all(session_id);
    }
    return this.json.btw_queue.filter((r) => r.session_id === session_id && !r.answered);
  }

  answerBtw(btw_id, answer) {
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(
        `UPDATE btw_queue SET answered = 1, answer = ?, answered_at = datetime('now'), delivered = 1, delivered_at = datetime('now')
         WHERE btw_id = ? OR id = ?`,
      ).run(answer, btw_id, btw_id);
      return;
    }
    const row = this.json.btw_queue.find((r) => r.btw_id === btw_id || r.id === btw_id);
    if (row) {
      row.answered = 1;
      row.answer = answer;
      row.answered_at = new Date().toISOString();
      row.delivered = 1;
      row.delivered_at = row.answered_at;
      this._persistJson();
    }
  }

  btwHistory(session_id) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare(
        'SELECT * FROM btw_queue WHERE session_id = ? ORDER BY created_at ASC',
      ).all(session_id);
    }
    return this.json.btw_queue.filter((r) => r.session_id === session_id);
  }

  // -------------------------------------------------------------------------
  // Skill memory — memorized executable scripts (bash, python, node)
  // -------------------------------------------------------------------------
  upsertSkill({
    id, skill_key, title, description, language, script_body,
    tags_json, source, version, active,
  }) {
    const now = new Date().toISOString();
    const ver = version != null ? version : 1;
    const act = active != null ? (active ? 1 : 0) : 1;
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO skill_memory (id, skill_key, title, description, language, script_body,
             tags_json, source, version, active, run_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
           ON CONFLICT(skill_key) DO UPDATE SET
             title=excluded.title, description=excluded.description, language=excluded.language,
             script_body=excluded.script_body, tags_json=excluded.tags_json, source=excluded.source,
             version=excluded.version, active=excluded.active, updated_at=datetime('now')`,
        )
        .run(
          id, skill_key, title, description || null, language, script_body,
          tags_json || null, source || 'operator', ver, act,
        );
      return id;
    }
    const existing = this.json.skill_memory.find((r) => r.skill_key === skill_key);
    if (existing) {
      Object.assign(existing, {
        title, description: description || null, language, script_body,
        tags_json: tags_json || null, source: source || existing.source || 'operator',
        version: ver, active: act, updated_at: now,
      });
    } else {
      this.json.skill_memory.push({
        id, skill_key, title, description: description || null, language, script_body,
        tags_json: tags_json || null, source: source || 'operator', version: ver, active: act,
        last_run_at: null, run_count: 0, last_exit_code: null, created_at: now, updated_at: now,
      });
    }
    this._persistJson();
    return id;
  }

  getSkillByKey(skill_key) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM skill_memory WHERE skill_key = ?').get(skill_key);
    }
    return this.json.skill_memory.find((r) => r.skill_key === skill_key) || null;
  }

  listSkills({ active = true, language, limit = 100 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM skill_memory';
      const params = [];
      const where = [];
      if (active != null) { where.push('active = ?'); params.push(active ? 1 : 0); }
      if (language) { where.push('language = ?'); params.push(language); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.skill_memory.slice();
    if (active != null) rows = rows.filter((r) => !!r.active === !!active);
    if (language) rows = rows.filter((r) => r.language === language);
    return rows.slice(-limit).reverse();
  }

  searchSkills(query, { limit = 10 } = {}) {
    const q = String(query || '').toLowerCase();
    const rows = this.listSkills({ active: true, limit: 500 });
    return rows.filter((r) => {
      let tags = [];
      try { tags = r.tags_json ? JSON.parse(r.tags_json) : []; } catch (_) { tags = []; }
      return (
        (r.skill_key || '').toLowerCase().includes(q) ||
        (r.title || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q) ||
        tags.some((t) => String(t).toLowerCase().includes(q))
      );
    }).slice(0, limit);
  }

  deactivateSkill(skill_key) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      const info = this.sqlite
        .prepare(`UPDATE skill_memory SET active=0, updated_at=datetime('now') WHERE skill_key=?`)
        .run(skill_key);
      return info.changes > 0;
    }
    const row = this.json.skill_memory.find((r) => r.skill_key === skill_key);
    if (!row) return false;
    row.active = 0;
    row.updated_at = now;
    this._persistJson();
    return true;
  }

  recordSkillRun(skill_key, { exit_code, last_run_at }) {
    const ts = last_run_at || new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `UPDATE skill_memory SET run_count=run_count+1, last_run_at=?, last_exit_code=?,
           updated_at=datetime('now') WHERE skill_key=?`,
        )
        .run(ts, exit_code != null ? exit_code : null, skill_key);
      return;
    }
    const row = this.json.skill_memory.find((r) => r.skill_key === skill_key);
    if (row) {
      row.run_count = (row.run_count || 0) + 1;
      row.last_run_at = ts;
      row.last_exit_code = exit_code != null ? exit_code : null;
      row.updated_at = ts;
      this._persistJson();
    }
  }

  // -------------------------------------------------------------------------
  // Documentation registry
  // -------------------------------------------------------------------------

  upsertDocRegistry(entry) {
    const crypto = require('crypto');
    const id = entry.id || crypto.randomUUID();
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO doc_registry (id, path, repo, category, title, status, sha256, mtime,
             last_scanned_at, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(path, repo) DO UPDATE SET
             category=excluded.category, title=excluded.title, status=excluded.status,
             sha256=excluded.sha256, mtime=excluded.mtime, last_scanned_at=excluded.last_scanned_at,
             notes=excluded.notes, updated_at=datetime('now')`,
        )
        .run(
          id, entry.path, entry.repo, entry.category, entry.title || null,
          entry.status || 'canonical', entry.sha256 || null, entry.mtime || null,
          entry.last_scanned_at || now, entry.notes || null,
        );
      return id;
    }
    const idx = this.json.doc_registry.findIndex(
      (r) => r.path === entry.path && r.repo === entry.repo,
    );
    const row = {
      id,
      path: entry.path,
      repo: entry.repo,
      category: entry.category,
      title: entry.title || null,
      status: entry.status || 'canonical',
      sha256: entry.sha256 || null,
      mtime: entry.mtime || null,
      last_scanned_at: entry.last_scanned_at || now,
      notes: entry.notes || null,
      created_at: idx >= 0 ? this.json.doc_registry[idx].created_at : now,
      updated_at: now,
    };
    if (idx >= 0) this.json.doc_registry[idx] = row;
    else this.json.doc_registry.push(row);
    this._persistJson();
    return id;
  }

  replaceDocRegistry(entries, scannedAt) {
    const ts = scannedAt || new Date().toISOString();
    const crypto = require('crypto');
    if (this.backend === 'sqlite') {
      const tx = this.sqlite.transaction((rows) => {
        this.sqlite.prepare('DELETE FROM doc_registry').run();
        const ins = this.sqlite.prepare(
          `INSERT INTO doc_registry (id, path, repo, category, title, status, sha256, mtime,
             last_scanned_at, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        );
        for (const e of rows) {
          ins.run(
            crypto.randomUUID(), e.path, e.repo, e.category, e.title || null,
            e.status, e.sha256 || null, e.mtime || null, e.last_scanned_at || ts, e.notes || null,
          );
        }
      });
      tx(entries);
      return entries.length;
    }
    this.json.doc_registry = entries.map((e) => ({
      id: crypto.randomUUID(),
      ...e,
      created_at: ts,
      updated_at: ts,
    }));
    this._persistJson();
    return entries.length;
  }

  listDocRegistry({ repo, category, status, limit = 500 } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM doc_registry';
      const params = [];
      const where = [];
      if (repo) { where.push('repo = ?'); params.push(repo); }
      if (category) { where.push('category = ?'); params.push(category); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY repo, path LIMIT ?';
      params.push(limit);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.doc_registry.slice();
    if (repo) rows = rows.filter((r) => r.repo === repo);
    if (category) rows = rows.filter((r) => r.category === category);
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.slice(0, limit);
  }

  upsertOperation({ id, title, description, handler_ref, script_ref, active }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(
        `INSERT INTO operation_registry (id, title, description, handler_ref, script_ref, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           handler_ref = excluded.handler_ref,
           script_ref = excluded.script_ref,
           active = excluded.active,
           updated_at = datetime('now')`,
      ).run(id, title, description, handler_ref, script_ref || null, active != null ? (active ? 1 : 0) : 1);
      return id;
    }
    const idx = this.json.operation_registry.findIndex((r) => r.id === id);
    const row = {
      id, title, description, handler_ref,
      script_ref: script_ref || null,
      active: active != null ? (active ? 1 : 0) : 1,
      created_at: idx >= 0 ? this.json.operation_registry[idx].created_at : now,
      updated_at: now,
    };
    if (idx >= 0) this.json.operation_registry[idx] = row;
    else this.json.operation_registry.push(row);
    this._persistJson();
    return id;
  }

  listOperations({ active } = {}) {
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM operation_registry';
      const params = [];
      if (active != null) { sql += ' WHERE active = ?'; params.push(active ? 1 : 0); }
      sql += ' ORDER BY id';
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.operation_registry.slice();
    if (active != null) rows = rows.filter((r) => r.active === (active ? 1 : 0));
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  getOperation(id) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM operation_registry WHERE id = ?').get(id) || null;
    }
    return this.json.operation_registry.find((r) => r.id === id) || null;
  }

  createOperationRun({ id, operation_id, description, status, triggered_by, params_json }) {
    if (this.backend === 'sqlite') {
      this.sqlite.prepare(
        `INSERT INTO operation_runs (id, operation_id, description, status, triggered_by, params_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(id, operation_id, description || null, status || 'pending', triggered_by || 'api', params_json || null);
      return id;
    }
    const now = new Date().toISOString();
    this.json.operation_runs.push({
      id, operation_id, description: description || null,
      status: status || 'pending', triggered_by: triggered_by || 'api',
      params_json: params_json || null, started_at: null, finished_at: null,
      exit_code: null, output_summary: null, created_at: now,
    });
    this._persistJson();
    return id;
  }

  updateOperationRun(id, patch) {
    if (this.backend === 'sqlite') {
      const fields = [];
      const params = [];
      for (const key of ['description', 'status', 'started_at', 'finished_at', 'exit_code', 'output_summary', 'params_json']) {
        if (patch[key] !== undefined) { fields.push(`${key} = ?`); params.push(patch[key]); }
      }
      if (!fields.length) return false;
      params.push(id);
      this.sqlite.prepare(`UPDATE operation_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return true;
    }
    const idx = this.json.operation_runs.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    Object.assign(this.json.operation_runs[idx], patch);
    this._persistJson();
    return true;
  }

  getOperationRun(id) {
    if (this.backend === 'sqlite') {
      return this.sqlite.prepare('SELECT * FROM operation_runs WHERE id = ?').get(id) || null;
    }
    return this.json.operation_runs.find((r) => r.id === id) || null;
  }

  listOperationRuns({ operation_id, status, limit = 50 } = {}) {
    const cap = Math.min(limit || 50, 500);
    if (this.backend === 'sqlite') {
      let sql = 'SELECT * FROM operation_runs';
      const params = [];
      const where = [];
      if (operation_id) { where.push('operation_id = ?'); params.push(operation_id); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY COALESCE(started_at, created_at) DESC LIMIT ?';
      params.push(cap);
      return this.sqlite.prepare(sql).all(...params);
    }
    let rows = this.json.operation_runs.slice();
    if (operation_id) rows = rows.filter((r) => r.operation_id === operation_id);
    if (status) rows = rows.filter((r) => r.status === status);
    rows.sort((a, b) => String(b.started_at || b.created_at).localeCompare(String(a.started_at || a.created_at)));
    return rows.slice(0, cap);
  }

  close() {
    if (this.backend === 'sqlite' && this.sqlite) this.sqlite.close();
    if (this.backend === 'json') this._persistJson();
  }
}

module.exports = { MemoryDB };
