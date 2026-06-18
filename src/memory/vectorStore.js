'use strict';

/**
 * Vector store abstraction (Spec v1.1 §5, Annex A §D).
 *
 * Phase 1 intended store is sqlite-vec (embedded). If the sqlite-vec native
 * binary / better-sqlite3 is unavailable in the build sandbox, we fall back to a
 * pure-JS cosine similarity over vectors stored as BLOBs in plain SQLite-shaped
 * rows. Both paths implement the same interface so the code runs and tests pass.
 *
 * NOTE: This module is intentionally store-agnostic and dependency-light. The
 * actual SQLite connection is owned by db.js; here we provide the math + the
 * capability probe.
 */

/**
 * Encode a numeric array as a Float32 Buffer for BLOB storage.
 */
function encodeVector(arr) {
  const f = new Float32Array(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/**
 * Decode a Float32 BLOB back into a JS number array.
 */
function decodeVector(buf) {
  if (!buf) return [];
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(f);
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pure-JS top-k search over an array of { id, body, vector } rows.
 */
function topK(queryVector, rows, k = 5) {
  return rows
    .map((r) => ({ ...r, score: cosineSimilarity(queryVector, r.vector) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

/**
 * Probe whether sqlite-vec can be loaded as a better-sqlite3 extension.
 * Returns { available, reason }.
 */
function probeSqliteVec() {
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
  } catch (_) {
    return { available: false, reason: 'better-sqlite3 not installed' };
  }
  try {
    // eslint-disable-next-line global-require
    require('sqlite-vec');
    return { available: true, reason: 'sqlite-vec present' };
  } catch (_) {
    return { available: false, reason: 'sqlite-vec not installed (using pure-JS cosine fallback)' };
  }
}

module.exports = {
  encodeVector,
  decodeVector,
  cosineSimilarity,
  topK,
  probeSqliteVec,
};
