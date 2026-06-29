'use strict';

/**
 * Redact accidental KEY=value leaks from fleet operation JSON results.
 */

const ENV_LINE_RE = /^[A-Z_][A-Z0-9_]*\s*=\s*.+$/;

function redactEnvLikeString(value) {
  if (typeof value !== 'string') return value;
  if (ENV_LINE_RE.test(value.trim())) return '[REDACTED]';
  return value;
}

function redactFleetResult(obj) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactFleetResult(item));
  }
  if (typeof obj !== 'object') {
    return redactEnvLikeString(obj);
  }
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'paths' && Array.isArray(val)) {
      out.paths = val.map((p) => (typeof p === 'string' ? p : redactFleetResult(p)));
      continue;
    }
    if (key === 'errors' && Array.isArray(val)) {
      out.errors = val.map((e) => redactEnvLikeString(String(e)));
      continue;
    }
    out[key] = redactFleetResult(val);
  }
  return out;
}

module.exports = { redactFleetResult, redactEnvLikeString, ENV_LINE_RE };
