'use strict';

/**
 * Correlate Nagios state-transition events into work_memory incidents.
 *
 * One open incident per Nagios object (host:… or service:…). Repeated hard
 * CRITICAL/WARNING checks do not open a second incident. Recovery from Nagios
 * (verified SoT transition) closes the incident — OMBrain does not invent
 * recovery without a Nagios OK/UP transition.
 */

const crypto = require('crypto');

function sessionIdFor(nagiosObject) {
  const key = String(nagiosObject || 'unknown');
  // Stable, filesystem-safe id (keep readable prefix for operators).
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `nagios:${hash}`;
}

function tierFor(severity, eventType) {
  if (eventType && String(eventType).startsWith('host.')) return 'T1';
  if (severity === 'critical') return 'T1';
  if (severity === 'warning') return 'T2';
  return 'T3';
}

/**
 * @param {object} db MemoryDb
 * @param {object} evt { event_type, severity, nagios_object, payload, event_id }
 * @returns {{ action: string, session_id: string, state: string|null }}
 */
function correlateNagiosEvent(db, evt) {
  if (!db || typeof db.upsertWorkSession !== 'function') {
    return { action: 'skipped_no_db', session_id: null, state: null };
  }
  const nagiosObject = evt.nagios_object || (evt.payload && evt.payload.nagios_object);
  if (!nagiosObject) {
    return { action: 'skipped_no_object', session_id: null, state: null };
  }

  const session_id = sessionIdFor(nagiosObject);
  const existing = typeof db.getWorkSession === 'function' ? db.getWorkSession(session_id) : null;
  const eventType = evt.event_type;
  const isRecovery =
    eventType === 'host.recovered' || eventType === 'service.recovered';
  const isBad =
    eventType === 'host.unreachable' || eventType === 'service.unhealthy';

  const priorContext = (() => {
    if (!existing || !existing.context_json) return {};
    try {
      return JSON.parse(existing.context_json) || {};
    } catch (_) {
      return {};
    }
  })();

  const context = {
    ...priorContext,
    source_system: 'nagios',
    nagios_object: nagiosObject,
    last_event_type: eventType,
    last_severity: evt.severity || null,
    last_event_id: evt.event_id || null,
    last_payload: evt.payload || null,
    transition_count: (priorContext.transition_count || 0) + 1,
    recovered_verified: false,
  };

  if (isBad) {
    const payload = evt.payload || {};
    const inDowntime = payload.downtime_state === true;
    // Scheduled downtime: do not open actionable incidents unless policy flips.
    // Still allow updates when an incident is already open.
    const alreadyOpen =
      existing &&
      existing.state &&
      !['closed', 'resolved'].includes(String(existing.state));

    if (inDowntime && !alreadyOpen) {
      context.opened_by = priorContext.opened_by || eventType;
      context.recovered_verified = false;
      context.suppressed_reason = 'scheduled_downtime';
      context.acknowledgement_state =
        payload.acknowledgement_state != null ? !!payload.acknowledgement_state : null;
      context.observation_origin = payload.observation_origin || null;
      context.synthetic = !!payload.synthetic;
      return {
        action: 'suppressed_downtime',
        session_id,
        state: existing ? existing.state : null,
      };
    }

    context.opened_by = priorContext.opened_by || eventType;
    context.recovered_verified = false;
    context.acknowledgement_state =
      payload.acknowledgement_state != null
        ? !!payload.acknowledgement_state
        : priorContext.acknowledgement_state != null
          ? priorContext.acknowledgement_state
          : null;
    context.downtime_state =
      payload.downtime_state != null ? !!payload.downtime_state : priorContext.downtime_state || false;
    context.observation_origin = payload.observation_origin || priorContext.observation_origin || null;
    context.synthetic = payload.synthetic != null ? !!payload.synthetic : !!priorContext.synthetic;
    context.transition_observed =
      payload.transition_observed != null
        ? !!payload.transition_observed
        : priorContext.transition_observed;
    if (payload.resource_identity) {
      context.resource_identity = payload.resource_identity;
    }
    db.upsertWorkSession({
      session_id,
      work_item_ref: nagiosObject,
      incident_tier: tierFor(evt.severity, eventType),
      state: alreadyOpen ? existing.state === 'recovery_pending' ? 'open' : existing.state || 'open' : 'open',
      context_json: JSON.stringify(context),
      correlation_id: nagiosObject,
    });
    return {
      action: alreadyOpen ? 'updated_open_incident' : 'opened_incident',
      session_id,
      state: alreadyOpen ? existing.state || 'open' : 'open',
    };
  }

  if (isRecovery) {
    // Nagios OK/UP transition is the verification signal — close only then.
    context.recovered_verified = true;
    context.recovery_event_type = eventType;
    context.recovery_at = new Date().toISOString();
    if (!existing) {
      // Orphan recovery (baseline missed open) — record closed for audit trail.
      db.upsertWorkSession({
        session_id,
        work_item_ref: nagiosObject,
        incident_tier: tierFor('success', eventType),
        state: 'closed',
        context_json: JSON.stringify(context),
        correlation_id: nagiosObject,
      });
      return { action: 'closed_orphan_recovery', session_id, state: 'closed' };
    }
    db.upsertWorkSession({
      session_id,
      work_item_ref: nagiosObject,
      incident_tier: existing.incident_tier || tierFor(evt.severity, eventType),
      state: 'closed',
      context_json: JSON.stringify(context),
      correlation_id: nagiosObject,
    });
    return { action: 'closed_verified_recovery', session_id, state: 'closed' };
  }

  return { action: 'ignored_event_type', session_id, state: existing ? existing.state : null };
}

module.exports = {
  correlateNagiosEvent,
  sessionIdFor,
  tierFor,
};
