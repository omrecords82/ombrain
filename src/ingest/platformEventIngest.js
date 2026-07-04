'use strict';

/**
 * Platform event push ingest (Option A) — POST /brain/ingest/event.
 *
 * Any OM-family service may POST operational events directly to om-brain.
 * Payloads are redacted before persistence into event_memory (same store as
 * the read-only event adapter).
 */

const { validateWebhookSecret } = require('../governance/omstudioClient');
const { resolveTargetIdentity, isHostReachabilityEvent } = require('./eventIdentity');

const ALLOWED_SOURCES = Object.freeze(['om', 'omstudio', 'workshop', 'omai']);

function resolveIngestSecret(env = process.env) {
  return env.BRAIN_INGEST_SECRET || env.OMSTUDIO_WEBHOOK_SECRET || '';
}

function validateIngestAuth(headerValue, env = process.env) {
  return validateWebhookSecret(headerValue || '', resolveIngestSecret(env));
}

/**
 * @param {object} body  parsed JSON body
 * @returns {{ ok: true, source: string, eventType: string, timestamp: *, data: object, severity: *, correlation: * } | { ok: false, reason: string }}
 */
function validateIngestPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_body' };
  }

  const source = String(body.source || '').toLowerCase();
  if (!ALLOWED_SOURCES.includes(source)) {
    return { ok: false, reason: 'invalid_source' };
  }

  const eventType = body.type != null ? body.type : body.event_type;
  if (eventType == null || String(eventType).trim() === '') {
    return { ok: false, reason: 'missing_type' };
  }

  const data = body.data != null ? body.data : {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'invalid_data' };
  }

  const correlation =
    body.correlation ||
    body.request_id ||
    body.run_id ||
    (data && (data.id || data.request_id || data.correlation || data.run_id)) ||
    null;

  const severityRaw = body.severity || (data && data.severity) || null;
  const severity = severityRaw != null ? String(severityRaw).toLowerCase() : null;

  return {
    ok: true,
    source,
    eventType: String(eventType),
    timestamp: body.timestamp || null,
    data,
    severity,
    correlation: correlation != null ? String(correlation) : null,
    summary: body.summary != null ? String(body.summary).slice(0, 512) : null,
    actor_type: body.actor_type != null ? String(body.actor_type) : null,
    actor_id: body.actor_id != null ? String(body.actor_id) : null,
    run_id: body.run_id != null ? String(body.run_id) : null,
    object_type: body.object_type != null ? String(body.object_type) : null,
    object_id: body.object_id != null ? String(body.object_id) : null,
  };
}

/**
 * @param {object} db
 * @param {object} validated  output of validateIngestPayload when ok
 * @param {function} redactForLog
 */
function persistIngestedEvent(db, validated, redactForLog) {
  const envelopeFields = {};
  if (validated.summary) envelopeFields.summary = validated.summary;
  if (validated.actor_type) envelopeFields.actor_type = validated.actor_type;
  if (validated.actor_id) envelopeFields.actor_id = validated.actor_id;
  if (validated.run_id) envelopeFields.run_id = validated.run_id;
  if (validated.object_type) envelopeFields.object_type = validated.object_type;
  if (validated.object_id) envelopeFields.object_id = validated.object_id;

  const safePayload = redactForLog({
    ...validated.data,
    ...envelopeFields,
    client_timestamp: validated.timestamp,
    ingested_via: 'push',
  });

  // Registry-enriched target identity: a push with only a service key
  // (e.g. source 'omstudio') is resolved through inventory/hosts.json before
  // persistence; unresolvable host events are stored marked 'malformed'.
  const identity = resolveTargetIdentity(
    validated.eventType,
    isHostReachabilityEvent(validated.eventType)
      ? { ...safePayload, service: safePayload.service || safePayload.app || validated.source }
      : safePayload,
  );
  if (identity.registry_resolution) {
    safePayload.registry_resolution = identity.registry_resolution;
  }

  db.insertEvent({
    source: validated.source,
    event_type: validated.eventType,
    severity: validated.severity,
    church_id: null,
    correlation: validated.correlation,
    payload_json: JSON.stringify(safePayload),
    target_name: identity.target_name,
    target_ip: identity.target_ip,
    target_host: identity.target_host,
    target_service: identity.target_service,
    check_method: identity.check_method,
    checked_from: identity.checked_from,
    target_identity_status: identity.target_identity_status,
  });

  return {
    ok: true,
    source: validated.source,
    type: validated.eventType,
  };
}

module.exports = {
  ALLOWED_SOURCES,
  resolveIngestSecret,
  validateIngestAuth,
  validateIngestPayload,
  persistIngestedEvent,
};
