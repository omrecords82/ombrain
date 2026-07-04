'use strict';

/**
 * Target-identity enrichment for ingested platform events.
 *
 * Every host reachability event (host.unreachable / host.recovered) MUST
 * identify the affected host: target_name + target_ip (+ target_host /
 * target_service where known). Producers are expected to emit a full identity
 * envelope (OMAI platform_inventory does since 2026-07-04); when a payload
 * arrives with only a name / service key / hostname, om-brain resolves it
 * through the central registry (inventory/hosts.json) BEFORE persisting.
 * When no target can be determined the event is marked 'malformed' so the
 * console displays it as "Unknown host unreachable — malformed telemetry"
 * and never collapses it into a normal host incident.
 */

const logger = require('../util/logger');

let resolveHost = null;
try {
  // eslint-disable-next-line global-require
  ({ resolveHost } = require('../fleet/hosts'));
} catch (_) {
  resolveHost = null;
}

const HOST_EVENT_RE = /^host\.(unreachable|recovered)$/i;

function isHostReachabilityEvent(eventType) {
  return HOST_EVENT_RE.test(String(eventType || ''));
}

function firstString(...values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Pull identity candidates out of the raw (already-redacted) payload. */
function extractCandidates(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // OMAI platform_events rows nest producer detail under event_payload;
  // push-ingest bodies may nest under data; some producers use flat fields.
  const layers = [p.event_payload, p.data, p].filter(
    (l) => l && typeof l === 'object' && !Array.isArray(l),
  );
  const pick = (...keys) => {
    for (const layer of layers) {
      for (const key of keys) {
        if (layer[key] != null && String(layer[key]).trim() !== '') {
          return String(layer[key]).trim();
        }
      }
    }
    return null;
  };

  return {
    ip: pick('target_ip', 'ip', 'host_ip'),
    host: pick('target_host', 'hostname', 'host', 'fqdn'),
    name: pick('target_name', 'host_id', 'server_id', 'name'),
    service: pick('target_service', 'service', 'app', 'service_key'),
    endpoint: pick('check_endpoint', 'endpoint', 'url'),
    port: pick('target_port', 'port'),
    method: pick('check_method', 'method', 'collector'),
    checkedFrom: pick('checked_from', 'source_host'),
  };
}

/** Try the central registry with every identity handle we have. */
function registryLookup(candidates) {
  if (!resolveHost) return null;
  const handles = [
    candidates.ip,
    candidates.name,
    candidates.host,
    candidates.service,
    // short hostname without .local / .internal / domain suffix
    candidates.host ? candidates.host.split('.')[0] : null,
  ].filter(Boolean);

  for (const handle of handles) {
    try {
      const hit = resolveHost(handle);
      if (hit) return hit;
    } catch (_) {
      // registry unavailable — treated as unresolvable below
    }
  }
  return null;
}

/**
 * Resolve the target identity for one ingested event.
 *
 * @param {string} eventType
 * @param {object} payload  redacted payload object (NOT a JSON string)
 * @returns {{
 *   target_name: string|null, target_ip: string|null, target_host: string|null,
 *   target_service: string|null, check_method: string|null, checked_from: string|null,
 *   target_identity_status: 'producer_provided'|'resolved'|'malformed'|null,
 *   registry_resolution: object|null,
 * }}
 */
function resolveTargetIdentity(eventType, payload) {
  const empty = {
    target_name: null,
    target_ip: null,
    target_host: null,
    target_service: null,
    check_method: null,
    checked_from: null,
    target_identity_status: null,
    registry_resolution: null,
  };

  const c = extractCandidates(payload);
  const hasAnyHandle = c.ip || c.host || c.name || c.service || c.endpoint;
  const hostEvent = isHostReachabilityEvent(eventType);

  // Non-host events only get identity when the producer supplied handles;
  // we never force a target concept onto unrelated event types.
  if (!hostEvent && !hasAnyHandle) return empty;

  let ip = c.ip && IP_RE.test(c.ip) ? c.ip : null;
  let name = c.name;
  let host = c.host;
  let service = c.service;
  let registryResolution = null;
  let status = null;

  const registryHit = registryLookup(c);
  if (registryHit) {
    registryResolution = {
      matched: true,
      registry_name: registryHit.name,
      registry_ip: registryHit.ip || null,
      role: registryHit.role || null,
    };
    if (!ip && registryHit.ip) ip = registryHit.ip;
    if (!name) name = registryHit.name;
    if (!host && registryHit.name) host = c.host || null;
    if (!service) service = registryHit.name;
  } else if (hasAnyHandle) {
    registryResolution = { matched: false, handles_tried: [c.ip, c.name, c.host, c.service].filter(Boolean) };
  }

  if (ip && c.ip) {
    status = 'producer_provided';
  } else if (ip) {
    status = 'resolved';
  } else if (host || name) {
    // Identity partially known (hostname/name but no resolvable IP) —
    // displayable per title priority, but flag that the registry could not
    // fill the IP so the producer/registry gap is visible.
    status = registryHit ? 'resolved' : 'producer_provided';
    if (hostEvent && !registryHit) {
      logger.warn('event_identity_ip_unresolved', {
        event_type: String(eventType || ''),
        target_host: host || null,
        target_name: name || null,
      });
    }
  } else if (hostEvent) {
    status = 'malformed';
    logger.warn('event_identity_malformed', {
      event_type: String(eventType || ''),
      reason: 'target_ip_and_target_host_unresolvable',
      handles: [c.name, c.host, c.service, c.endpoint].filter(Boolean),
    });
  }

  return {
    target_name: name || null,
    target_ip: ip || null,
    target_host: host || null,
    target_service: service || null,
    check_method: c.method || null,
    checked_from: c.checkedFrom || null,
    target_identity_status: status,
    registry_resolution: registryResolution,
  };
}

module.exports = { resolveTargetIdentity, isHostReachabilityEvent };
