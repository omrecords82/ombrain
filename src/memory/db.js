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
      _seq: { doctrine: 0, systruth: 0, event: 0, work: 0, decision: 0, approval: 0, apphist: 0, omaudit: 0, task: 0, knowledge: 0, procedure: 0, correction: 0, theology: 0, church: 0, btw: 0 },
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

  getTheologyByRef(reference_key) {
    if (this.backend === 'sqlite') return this.sqlite.prepare('SELECT * FROM theological_memory WHERE reference_key = ?').get(reference_key);
    return this.json.theological_memory.find((r) => r.reference_key === reference_key) || null;
  }

  // -------------------------------------------------------------------------
  // Church memory — Orthodox parish data
  // -------------------------------------------------------------------------
  upsertChurch({ id, place_id, name, jurisdiction, address, city, state, country, lat, lng, phone, website, liturgical_calendar, source, last_verified }) {
    const now = new Date().toISOString();
    if (this.backend === 'sqlite') {
      this.sqlite
        .prepare(
          `INSERT INTO church_memory (id, place_id, name, jurisdiction, address, city, state, country, lat, lng, phone, website, liturgical_calendar, source, last_verified, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             place_id=excluded.place_id, name=excluded.name, jurisdiction=excluded.jurisdiction,
             address=excluded.address, city=excluded.city, state=excluded.state, country=excluded.country,
             lat=excluded.lat, lng=excluded.lng, phone=excluded.phone, website=excluded.website,
             liturgical_calendar=excluded.liturgical_calendar, source=excluded.source,
             last_verified=excluded.last_verified, updated_at=datetime('now')`,
        )
        .run(id, place_id || null, name, jurisdiction || null, address || null, city || null,
          state || null, country || 'US', lat || null, lng || null, phone || null,
          website || null, liturgical_calendar || null, source, last_verified || null);
      return id;
    }
    const existing = this.json.church_memory.find((r) => r.id === id);
    if (existing) {
      Object.assign(existing, { place_id, name, jurisdiction, address, city, state, country, lat, lng, phone, website, liturgical_calendar, source, last_verified, updated_at: now });
    } else {
      this.json.church_memory.push({ id, place_id: place_id || null, name, jurisdiction: jurisdiction || null,
        address: address || null, city: city || null, state: state || null, country: country || 'US',
        lat: lat || null, lng: lng || null, phone: phone || null, website: website || null,
        liturgical_calendar: liturgical_calendar || null, source, last_verified: last_verified || null,
        created_at: now, updated_at: now });
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

  close() {
    if (this.backend === 'sqlite' && this.sqlite) this.sqlite.close();
    if (this.backend === 'json') this._persistJson();
  }
}

module.exports = { MemoryDB };
