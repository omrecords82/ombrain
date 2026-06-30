'use strict';

/**
 * Ops-plane JWT validation for ingestion adapters (no secret logging).
 */

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
      role: null,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const expiresInSec = exp != null ? exp - nowSec : null;
  const expired = exp != null && exp <= nowSec;
  return {
    configured: true,
    valid: !expired,
    reason: expired ? 'expired' : null,
    expires_at: exp != null ? new Date(exp * 1000).toISOString() : null,
    expires_in_sec: expiresInSec,
    role: payload.role || null,
  };
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
  assessOpsJwt,
  validateIngestAuthConfig,
  decodeJwtPayload,
};
