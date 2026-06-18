'use strict';

/**
 * Mandatory pre-flight redactor (Spec v1.1 Annex A §B.2, env-contract never-log
 * list, tenant-isolation rules).
 *
 * Two responsibilities:
 *   1. redactForModel(payload)  — strip never-log secrets and tenant identifiers
 *                                 from any payload BEFORE it reaches the model.
 *   2. redactForLog(value)      — same stripping for anything written to logs /
 *                                 persisted memory.
 *
 * The redactor is deterministic and pure. It is unit-tested. It must never let a
 * raw secret value or a church_id / om_church_* identifier through.
 */

const REDACTED = '[REDACTED]';
const TENANT_TOKEN = '[TENANT_REDACTED]';

// Never-log secret KEY names (env-contract §"Never-log list"). Case-insensitive.
// Matched as substrings of a key so JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, etc.
// are all caught, plus generic *_SECRET / *_TOKEN / *_PASSWORD / *_KEY families.
const SECRET_KEY_PATTERNS = [
  /db_password/i,
  /db_pass/i,
  /session_secret/i,
  /jwt[_-]?\w*secret/i,
  /stripe_secret_key/i,
  /stripe_webhook_secret/i,
  /omai_github_webhook_secret/i,
  /github_webhook_secret/i,
  /gh_token/i,
  /omstudio_service_token/i,
  /om_build_event_token/i,
  /smtp_password/i,
  /lob_api_key/i,
  /webhook_secret/i,
  /private_key/i,
  /ssh[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /\btoken\b/i,
];

// Value-shaped secret patterns (defense-in-depth for free-text payloads).
const SECRET_VALUE_PATTERNS = [
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Bearer tokens in free text
  /Bearer\s+[A-Za-z0-9._\-]+/g,
  // JWT-shaped tokens (three base64url segments)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Stripe secret/webhook keys
  /\b(sk|rk|whsec)_(live|test)?_?[A-Za-z0-9]{6,}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];

// Tenant identifier patterns (tenant.sanctity). church_id values and om_church_*
// database/path names must never reach the model or the logs.
const TENANT_KEY_PATTERNS = [/church_id/i, /churchid/i, /database_name/i];
const TENANT_VALUE_PATTERNS = [
  /\bom_church_\w+/gi, // om_church_46, om_church_278, ...
];

function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some((re) => re.test(String(key)));
}

function isTenantKey(key) {
  return TENANT_KEY_PATTERNS.some((re) => re.test(String(key)));
}

function redactString(str) {
  let out = String(str);
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  for (const re of TENANT_VALUE_PATTERNS) out = out.replace(re, TENANT_TOKEN);
  return out;
}

/**
 * Recursively redact an arbitrary JS value.
 * @param {*} value
 * @param {object} opts { tenant: boolean } — whether to also strip tenant ids.
 */
function redact(value, opts = { tenant: true }, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, opts, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      if (opts.tenant && isTenantKey(k)) {
        out[k] = TENANT_TOKEN;
        continue;
      }
      out[k] = redact(v, opts, seen);
    }
    return out;
  }

  // functions / symbols / bigint — never forward to model
  return undefined;
}

/**
 * Redact a payload before it is sent to the model. Strips secrets AND tenant ids.
 * Returns a deep-copied, safe-to-transmit structure.
 */
function redactForModel(payload) {
  return redact(payload, { tenant: true });
}

/**
 * Redact a value before logging / persisting. Same guarantees as redactForModel.
 * Accepts strings or objects.
 */
function redactForLog(value) {
  return redact(value, { tenant: true });
}

module.exports = {
  REDACTED,
  TENANT_TOKEN,
  isSecretKey,
  isTenantKey,
  redactString,
  redactForModel,
  redactForLog,
};
