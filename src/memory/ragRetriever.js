'use strict';

/**
 * RAG Retriever (Phase 2 memory-layer expansion).
 *
 * Ties together (1) an embedding function and (2) the vectorStore math to
 * produce ranked retrieval results from a memory table such as
 * `knowledge_memory` or `theological_memory`.
 *
 * Embedding strategy is PLUGGABLE behind a stable interface:
 *   - Production: pass an `embed(text) => number[]` backed by the local
 *     LiteLLM/Ollama embedding model (BRAIN_LLM_EMBEDDING_MODEL, e.g.
 *     `nomic-embed-text`, dim 768). This path needs live inference and is NOT
 *     reachable from a sandboxed agent.
 *   - Offline / tests / cold-start: when no `embed` is provided, a deterministic
 *     hashing embedder is used so the pipeline runs, is unit-testable, and
 *     degrades predictably. Same-text => same vector; similar token overlap =>
 *     higher cosine. It is NOT semantically meaningful — it exists so ranking
 *     code is exercised without external services.
 *
 * The retriever NEVER calls the network itself; it only calls the injected
 * `embed`. This keeps it inside the Brain's LAN-only doctrine by construction.
 */

const { cosineSimilarity, topK, decodeVector } = require('./vectorStore');

const DEFAULT_DIM = 256;

/**
 * Deterministic, dependency-free embedding fallback.
 * Token-hash bag-of-words projected into a fixed-dim L2-normalized vector.
 */
function deterministicEmbed(text, dim = DEFAULT_DIM) {
  const vec = new Array(dim).fill(0);
  if (!text) return vec;
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    // FNV-1a hash → bucket; sign from a second hash for some cancellation.
    let h = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const idx = h % dim;
    const sign = (h & 1) ? 1 : -1;
    vec[idx] += sign;
  }
  // L2 normalize.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

class RagRetriever {
  /**
   * @param {object} opts
   * @param {Function} [opts.embed] async|sync (text)=>number[]; defaults to deterministic
   * @param {number}   [opts.dim]   embedding dim for the fallback (default 256)
   * @param {object}   [opts.logger]
   */
  constructor(opts = {}) {
    this.dim = opts.dim || DEFAULT_DIM;
    this.usingFallback = typeof opts.embed !== 'function';
    this.embed = typeof opts.embed === 'function'
      ? opts.embed
      : (text) => deterministicEmbed(text, this.dim);
    this.logger = opts.logger || { info: () => {}, warn: () => {} };
  }

  /** Embed a query string into a vector (awaits if embed is async). */
  async embedQuery(text) {
    return await this.embed(text);
  }

  /**
   * Normalize a memory row into { id, text, vector, meta }.
   * Accepts rows whose vector is a number[], a Float32 BLOB/Buffer, or absent
   * (in which case it is embedded from the row's text on the fly).
   */
  async _prepareRow(row, { textField, vectorField }) {
    const text = row[textField] != null ? String(row[textField]) : '';
    let vector = row[vectorField];
    if (Buffer.isBuffer(vector) || (vector && vector.buffer)) {
      vector = decodeVector(vector);
    }
    if (!Array.isArray(vector) || vector.length === 0) {
      vector = await this.embed(text);
    }
    const { [vectorField]: _v, ...meta } = row;
    return { id: row.id != null ? row.id : null, text, vector, meta };
  }

  /**
   * Retrieve the top-k most similar rows to `query`.
   * @param {string} query
   * @param {Array<object>} rows  candidate memory rows
   * @param {object} opts
   * @param {number} [opts.k=5]
   * @param {string} [opts.textField='body']
   * @param {string} [opts.vectorField='embedding']
   * @param {number} [opts.minScore=0]  drop results below this cosine score
   * @returns {Promise<Array<{id,text,score,meta}>>}
   */
  async retrieve(query, rows, opts = {}) {
    const k = opts.k || 5;
    const textField = opts.textField || 'body';
    const vectorField = opts.vectorField || 'embedding';
    const minScore = opts.minScore != null ? opts.minScore : 0;

    if (!query || !Array.isArray(rows) || rows.length === 0) return [];

    const qVec = await this.embedQuery(query);
    const prepared = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      prepared.push(await this._prepareRow(row, { textField, vectorField }));
    }

    const ranked = topK(qVec, prepared, Math.max(k, prepared.length))
      .map((r) => ({ id: r.id, text: r.text, score: r.score, meta: r.meta }))
      .filter((r) => r.score >= minScore)
      .slice(0, k);

    this.logger.info('rag_retrieve', {
      query_len: String(query).length,
      candidates: rows.length,
      returned: ranked.length,
      fallback: this.usingFallback,
    });
    return ranked;
  }

  /** Cosine similarity between two arbitrary texts (debug/eval helper). */
  async similarity(a, b) {
    const [va, vb] = await Promise.all([this.embed(a), this.embed(b)]);
    return cosineSimilarity(va, vb);
  }
}

module.exports = { RagRetriever, deterministicEmbed, DEFAULT_DIM };
