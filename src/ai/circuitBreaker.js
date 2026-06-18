'use strict';

/**
 * Circuit breaker (Spec v1.1 Annex A §B.2, RULE inference.local_only_circuit_breaker).
 *
 * The AI client MUST refuse to call any host other than the configured
 * local/LAN endpoint. In production it HARD-BLOCKS api.openai.com and any
 * non-RFC1918 host. On local-inference failure the affected session is halted
 * and escalated (an escalation object is returned) — never silently re-routed.
 *
 * This module is pure and unit-tested.
 */

// Hosts that are always forbidden, regardless of mode.
const ALWAYS_BLOCKED_HOSTS = [
  'api.openai.com',
  'openai.com',
  'api.anthropic.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.groq.com',
];

function parseHost(urlOrHost) {
  if (!urlOrHost) return '';
  try {
    // Allow bare host:port or full URL.
    const u = /^[a-z]+:\/\//i.test(urlOrHost)
      ? new URL(urlOrHost)
      : new URL('http://' + urlOrHost);
    return u.hostname.toLowerCase();
  } catch (_) {
    return String(urlOrHost).toLowerCase();
  }
}

function isLoopback(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.')
  );
}

/**
 * RFC1918 private ranges:
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * Also accept loopback and link-local 169.254/16 as LAN-safe.
 */
function isRfc1918(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isLanHost(host) {
  return isLoopback(host) || isRfc1918(host);
}

/**
 * Decide whether a target URL/host may be contacted.
 *
 * @param {string} target  full URL or host
 * @param {object} opts    { production: boolean }
 * @returns {{ allowed: boolean, reason: string, host: string }}
 */
function checkHost(target, opts = {}) {
  const production = !!opts.production;
  const host = parseHost(target);

  if (!host) {
    return { allowed: false, reason: 'empty_or_unparseable_host', host };
  }

  if (ALWAYS_BLOCKED_HOSTS.some((b) => host === b || host.endsWith('.' + b))) {
    return { allowed: false, reason: 'external_llm_host_blocked', host };
  }

  // In production: ONLY loopback / RFC1918 LAN hosts are permitted.
  if (production && !isLanHost(host)) {
    return { allowed: false, reason: 'non_lan_host_blocked_in_production', host };
  }

  // In development we still block the known external LLM hosts (above), but allow
  // a localhost endpoint. We additionally warn (not block) on public hosts so
  // offline dev against a local Ollama is frictionless while never permitting an
  // external cloud LLM endpoint.
  if (!production && !isLanHost(host)) {
    return {
      allowed: false,
      reason: 'non_lan_host_blocked',
      host,
    };
  }

  return { allowed: true, reason: 'lan_or_loopback_ok', host };
}

/**
 * Build a standard escalation object for a halted session.
 */
function buildEscalation(sessionId, cause, detail) {
  return {
    escalation: true,
    halted: true,
    session_id: sessionId || null,
    classification: 'requires_human_superadmin',
    cause,
    detail: detail || null,
    doctrine_rule: 'inference.local_only_circuit_breaker',
    action: 'halt_and_escalate',
    message:
      'Local inference unavailable or target host blocked. Session halted and ' +
      'escalated to a human superadmin via OMStudio. No external re-routing performed.',
  };
}

module.exports = {
  ALWAYS_BLOCKED_HOSTS,
  parseHost,
  isLoopback,
  isRfc1918,
  isLanHost,
  checkHost,
  buildEscalation,
};
