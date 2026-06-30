'use strict';

/**
 * Ops-plane JWT validation for ingestion adapters (no secret logging).
 */

/** Warn in CLI, monitors, and logs when JWT expires within this many days. */
const OPS_AUTH_WARN_DAYS = 14;

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function assessOpsJwt(jwt) {
  if (!jwt) {
    return {
      configured: false,
      valid: false,
      reason: 'missing',
      expires_at: null,
      expires_in_sec: null,
      days_until_expiry: null,
      role: null,
    };
  }
  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    return {
      configured: true,
      valid: false,
      reason: 'malformed',
      expires_at: null,
      expires_in_sec: null,
      days_until_expiry: null,
      role: null,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const expiresInSec = exp != null ? exp - nowSec : null;
  const expired = exp != null && exp <= nowSec;
  const daysUntilExpiry = expiresInSec != null ? Math.floor(expiresInSec / 86400) : null;
  return {
    configured: true,
    valid: !expired,
    reason: expired ? 'expired' : null,
    expires_at: exp != null ? new Date(exp * 1000).toISOString() : null,
    expires_in_sec: expiresInSec,
    days_until_expiry: daysUntilExpiry,
    role: payload.role || null,
  };
}

function daysUntilExpiry(expiresInSec) {
  if (expiresInSec == null) return null;
  return Math.floor(expiresInSec / 86400);
}

function opsAuthHealthLevel(jwt) {
  if (!jwt.configured) return 'missing';
  if (jwt.reason === 'malformed') return 'malformed';
  if (!jwt.valid) return 'expired';
  const days = jwt.days_until_expiry != null ? jwt.days_until_expiry : daysUntilExpiry(jwt.expires_in_sec);
  if (days != null && days <= OPS_AUTH_WARN_DAYS) return 'near_expiry';
  return 'healthy';
}

/** Public /status and monitor fields — never includes the JWT or its payload. */
function buildOpsAuthPublicStatus(jwt) {
  const days = jwt.days_until_expiry != null ? jwt.days_until_expiry : daysUntilExpiry(jwt.expires_in_sec);
  const health = opsAuthHealthLevel({ ...jwt, days_until_expiry: days });
  return {
    valid: jwt.valid,
    expires_at: jwt.expires_at,
    days_until_expiry: days,
    health,
    warn_threshold_days: OPS_AUTH_WARN_DAYS,
    configured: jwt.configured,
    reason: jwt.reason,
  };
}

function opsAuthWarningMessage(jwt) {
  const pub = buildOpsAuthPublicStatus(jwt);
  if (pub.health === 'expired') {
    const when = pub.expires_at ? ` (expired ${pub.expires_at})` : '';
    return `BRAIN_OPS_JWT expired${when} — ingestion adapters degraded`;
  }
  if (pub.health === 'missing') return 'BRAIN_OPS_JWT not configured — ingestion adapters cannot authenticate';
  if (pub.health === 'malformed') return 'BRAIN_OPS_JWT malformed — ingestion adapters cannot authenticate';
  if (pub.health === 'near_expiry') {
    return `BRAIN_OPS_JWT expires in ${pub.days_until_expiry} day(s) on ${pub.expires_at || 'unknown date'}`;
  }
  return null;
}

function shouldWarnOpsAuth(jwt) {
  const level = opsAuthHealthLevel(jwt);
  return level === 'near_expiry' || level === 'expired' || level === 'missing' || level === 'malformed';
}

function validateIngestAuthConfig(cfg) {
  const issues = [];
  const jwt = assessOpsJwt(cfg.jwt);
  if (cfg.enableEventAdapter || cfg.enableInventoryAdapter || cfg.enableLogAdapter) {
    if (!jwt.configured) issues.push({ adapter: 'ops', code: 'missing_jwt', var: cfg.jwtVarName || 'BRAIN_OPS_JWT' });
    else if (!jwt.valid) issues.push({ adapter: 'ops', code: jwt.reason || 'invalid_jwt', var: cfg.jwtVarName || 'BRAIN_OPS_JWT' });
    if (!cfg.apiBaseUrl) issues.push({ adapter: 'ops', code: 'missing_api_base_url', var: 'OM_API_BASE_URL' });
  }
  return { jwt, issues };
}

module.exports = {
  OPS_AUTH_WARN_DAYS,
  assessOpsJwt,
  validateIngestAuthConfig,
  decodeJwtPayload,
  daysUntilExpiry,
  opsAuthHealthLevel,
  buildOpsAuthPublicStatus,
  opsAuthWarningMessage,
  shouldWarnOpsAuth,
};
