'use strict';

/**
 * Nagios status adapter (READ-ONLY).
 *
 * Polls Nagios Core JSON CGIs on the ops host and emits host/service
 * reachability transitions into event_memory. Nagios is the monitoring
 * source of truth for fleet health — platform_inventory probes must not
 * compete with these events (see PLATFORM_INVENTORY_EMIT_HEALTH_EVENTS).
 *
 * Query surface (no auth required on LAN today):
 *   http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=hostlist&details=true
 *   http://192.168.1.40:8080/nagios4/cgi-bin/statusjson.cgi?query=servicelist&details=true
 */

const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const adapterStatus = require('../health/adapterStatus');
const { resolveTargetIdentity } = require('../ingest/eventIdentity');
const { correlateNagiosEvent } = require('../ingest/nagiosIncidentCorrelator');
const logger = require('../util/logger');

// Nagios statusjson.cgi bitmasks (Core 4.x)
const HOST = { PENDING: 1, UP: 2, DOWN: 4, UNREACHABLE: 8 };
const SVC = { PENDING: 1, OK: 2, WARNING: 4, UNKNOWN: 8, CRITICAL: 16 };

function hostIpFromName(name) {
  const m = String(name || '').match(/^host-(\d+)-(\d+)-(\d+)-(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null;
}

function hostBucket(status) {
  const s = Number(status) || 0;
  if (s & HOST.DOWN || s & HOST.UNREACHABLE) return 'down';
  if (s & HOST.UP) return 'up';
  return 'pending';
}

function serviceBucket(status) {
  const s = Number(status) || 0;
  if (s & SVC.CRITICAL) return 'critical';
  if (s & SVC.WARNING) return 'warning';
  if (s & SVC.UNKNOWN) return 'unknown';
  if (s & SVC.OK) return 'ok';
  return 'pending';
}

function msToIso(ms) {
  if (!ms || Number(ms) <= 0) return null;
  try {
    return new Date(Number(ms)).toISOString();
  } catch (_) {
    return null;
  }
}

function severityRank(bucket) {
  if (bucket === 'critical' || bucket === 'down') return 3;
  if (bucket === 'warning') return 2;
  if (bucket === 'unknown' || bucket === 'pending') return 1;
  return 0;
}

class NagiosAdapter {
  constructor(deps = {}) {
    this.db = deps.db;
    this.fetch = deps.fetchImpl || globalThis.fetch;
    this.timer = null;
    this.cfg = config.ingest;
    this.prevHosts = null;
    this.prevServices = null;
    this.lastSnapshot = null;
    this.lastEventAt = null;
    this.correlator = deps.correlator || correlateNagiosEvent;
    /** In-process dedupe of identical transitions within one process lifetime. */
    this._recentKeys = new Set();
  }

  _url(query) {
    const base = this.cfg.nagiosStatusjsonUrl;
    const u = new URL(base);
    u.searchParams.set('query', query);
    u.searchParams.set('details', 'true');
    return u.toString();
  }

  async _getJson(query) {
    if (!this.fetch) throw new Error('no_fetch');
    const res = await this.fetch(this._url(query), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const err = new Error(`http_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  _idempotencyKey(nagiosObject, eventType, from, to) {
    return `${nagiosObject}|${eventType}|${from}->${to}`;
  }

  _insert(eventType, severity, payload) {
    const safe = redactForLog(payload);
    const identity = resolveTargetIdentity(eventType, safe);
    if (identity.registry_resolution) {
      safe.registry_resolution = identity.registry_resolution;
    }

    const fingerprint = safe.idempotency_key;
    if (fingerprint) {
      if (this._recentKeys.has(fingerprint)) {
        return { inserted: false, reason: 'in_memory_duplicate', id: null };
      }
      if (
        this.db &&
        typeof this.db.hasRecentEventFingerprint === 'function' &&
        this.db.hasRecentEventFingerprint({
          source: 'nagios',
          correlation: safe.nagios_object || null,
          event_type: eventType,
          fingerprint,
          withinSeconds: 6 * 3600,
        })
      ) {
        this._recentKeys.add(fingerprint);
        return { inserted: false, reason: 'db_duplicate', id: null };
      }
    }

    let eventId = null;
    if (this.db) {
      const result = this.db.insertEvent({
        source: 'nagios',
        event_type: eventType,
        severity,
        church_id: null,
        correlation: safe.nagios_object || null,
        payload_json: JSON.stringify(safe),
        target_name: identity.target_name,
        target_ip: identity.target_ip,
        target_host: identity.target_host,
        target_service: identity.target_service,
        check_method: identity.check_method || 'nagios',
        checked_from: identity.checked_from || this.cfg.nagiosCheckedFrom,
        target_identity_status: identity.target_identity_status,
      });
      eventId = result && result.id != null ? result.id : null;
    }

    if (fingerprint) this._recentKeys.add(fingerprint);
    this.lastEventAt = new Date().toISOString();

    const correlation = this.correlator(this.db, {
      event_type: eventType,
      severity,
      nagios_object: safe.nagios_object,
      payload: safe,
      event_id: eventId,
    });

    logger.info('nagios_event_ingested', {
      event_type: eventType,
      severity,
      nagios_object: safe.nagios_object,
      event_id: eventId,
      incident_action: correlation && correlation.action,
    });

    return { inserted: true, id: eventId, correlation };
  }

  _buildHostPayload({ name, ip, row, prev, bucket, eventType, severity }) {
    const nagiosObject = `host:${name}`;
    const from = prev.bucket;
    const to = bucket;
    return {
      event_id: null,
      source_system: 'nagios',
      source_host: this.cfg.nagiosCheckedFrom,
      monitored_host: name,
      monitored_service: null,
      timestamp: msToIso(row.last_check) || new Date().toISOString(),
      current_state: to,
      previous_state: from,
      state_type: row.state_type != null ? row.state_type : null,
      severity,
      check_output: row.plugin_output || null,
      performance_data: row.performance_data || null,
      attempt_number: row.current_attempt != null ? row.current_attempt : null,
      acknowledgement_state: row.problem_has_been_acknowledged != null
        ? !!row.problem_has_been_acknowledged
        : null,
      downtime_state: row.scheduled_downtime_depth != null
        ? Number(row.scheduled_downtime_depth) > 0
        : null,
      notification_state: row.notifications_enabled != null
        ? !!row.notifications_enabled
        : null,
      correlation_id: nagiosObject,
      raw_evidence_ref: `statusjson:hostlist:${name}`,
      normalized_resource_identity: `nagios/host/${name}`,
      event_type: eventType,
      category: 'system',
      title: eventType === 'host.unreachable'
        ? `Host unreachable: ${name}`
        : `Host recovered: ${name}`,
      message: `${name} (${ip || 'ip unknown'}) Nagios host ${from} → ${to}. ${row.plugin_output || ''}`.trim(),
      event_payload: {
        host_id: name,
        hostname: name,
        from,
        to,
        reason: row.plugin_output || null,
        nagios_status: row.status,
        last_check: msToIso(row.last_check),
        target_name: name,
        target_host: name,
        target_ip: ip,
        check_method: 'nagios',
        checked_from: this.cfg.nagiosCheckedFrom,
      },
      nagios_object: nagiosObject,
      idempotency_key: this._idempotencyKey(nagiosObject, eventType, from, to),
    };
  }

  _buildServicePayload({ hostName, svcName, ip, row, prev, bucket, eventType, severity }) {
    const key = `${hostName}::${svcName}`;
    const nagiosObject = `service:${key}`;
    const from = prev.bucket;
    const to = bucket;
    return {
      event_id: null,
      source_system: 'nagios',
      source_host: this.cfg.nagiosCheckedFrom,
      monitored_host: hostName,
      monitored_service: svcName,
      timestamp: msToIso(row.last_check) || new Date().toISOString(),
      current_state: to,
      previous_state: from,
      state_type: row.state_type != null ? row.state_type : null,
      severity,
      check_output: row.plugin_output || null,
      performance_data: row.performance_data || null,
      attempt_number: row.current_attempt != null ? row.current_attempt : null,
      acknowledgement_state: row.problem_has_been_acknowledged != null
        ? !!row.problem_has_been_acknowledged
        : null,
      downtime_state: row.scheduled_downtime_depth != null
        ? Number(row.scheduled_downtime_depth) > 0
        : null,
      notification_state: row.notifications_enabled != null
        ? !!row.notifications_enabled
        : null,
      correlation_id: nagiosObject,
      raw_evidence_ref: `statusjson:servicelist:${key}`,
      normalized_resource_identity: `nagios/service/${key}`,
      event_type: eventType,
      category: 'system',
      title: `${svcName} on ${hostName}: ${bucket}`,
      message: `${hostName}/${svcName} Nagios ${from} → ${to}. ${row.plugin_output || ''}`.trim(),
      event_payload: {
        host_id: hostName,
        hostname: hostName,
        service: svcName,
        from,
        to,
        reason: row.plugin_output || null,
        nagios_status: row.status,
        last_check: msToIso(row.last_check),
        target_name: hostName,
        target_host: hostName,
        target_ip: ip,
        target_service: svcName,
        check_method: 'nagios',
        checked_from: this.cfg.nagiosCheckedFrom,
      },
      nagios_object: nagiosObject,
      idempotency_key: this._idempotencyKey(nagiosObject, eventType, from, to),
    };
  }

  /**
   * Apply a hostlist snapshot. First call baselines without emitting.
   * Subsequent calls emit only real state transitions.
   */
  applyHostlist(hostlist) {
    const next = {};
    const emitted = [];
    for (const [name, row] of Object.entries(hostlist || {})) {
      if (!row || typeof row !== 'object') continue;
      const bucket = hostBucket(row.status);
      const ip = hostIpFromName(name);
      next[name] = { bucket, status: row.status, output: row.plugin_output || '', ip };

      if (!this.prevHosts) continue;
      const prev = this.prevHosts[name];
      if (!prev || prev.bucket === bucket) continue;

      const becameBad = bucket === 'down' && prev.bucket !== 'down';
      const recovered = prev.bucket === 'down' && bucket === 'up';
      if (!becameBad && !recovered) continue;

      const eventType = becameBad ? 'host.unreachable' : 'host.recovered';
      const severity = becameBad ? 'critical' : 'success';
      const payload = this._buildHostPayload({
        name, ip, row, prev, bucket, eventType, severity,
      });
      const result = this._insert(eventType, severity, payload);
      emitted.push({ eventType, result });
    }
    this.prevHosts = next;
    return emitted;
  }

  applyServicelist(servicelist) {
    const next = {};
    const emitted = [];
    for (const [hostName, services] of Object.entries(servicelist || {})) {
      if (!services || typeof services !== 'object') continue;
      for (const [svcName, row] of Object.entries(services)) {
        if (!row || typeof row !== 'object') continue;
        const key = `${hostName}::${svcName}`;
        const bucket = serviceBucket(row.status);
        const ip = hostIpFromName(hostName);
        next[key] = { bucket, status: row.status, output: row.plugin_output || '' };

        if (!this.prevServices) continue;
        const prev = this.prevServices[key];
        if (!prev || prev.bucket === bucket) continue;

        // Skip pure PING flaps when host-level events already cover reachability.
        if (svcName === 'PING') continue;

        const becameBad =
          severityRank(bucket) >= 2 && severityRank(prev.bucket) < 2;
        const recovered =
          severityRank(prev.bucket) >= 2 && bucket === 'ok';
        // warning ↔ critical still updates the same incident via a new event
        const escalated =
          prev.bucket === 'warning' && bucket === 'critical';
        const deescalated =
          prev.bucket === 'critical' && bucket === 'warning';
        if (!becameBad && !recovered && !escalated && !deescalated) continue;

        let eventType;
        let severity;
        if (recovered) {
          eventType = 'service.recovered';
          severity = 'success';
        } else if (becameBad || escalated || deescalated) {
          eventType = 'service.unhealthy';
          severity = bucket === 'critical' ? 'critical' : 'warning';
        }

        const payload = this._buildServicePayload({
          hostName, svcName, ip, row, prev, bucket, eventType, severity,
        });
        const result = this._insert(eventType, severity, payload);
        emitted.push({ eventType, result });
      }
    }
    this.prevServices = next;
    return emitted;
  }

  _publishSnapshot() {
    const hosts = Object.values(this.prevHosts || {});
    const services = Object.values(this.prevServices || {});
    const hostsDown = hosts.filter((h) => h.bucket === 'down').length;
    const svcCritical = services.filter((s) => s.bucket === 'critical').length;
    const svcWarning = services.filter((s) => s.bucket === 'warning').length;
    const svcUnknown = services.filter((s) => s.bucket === 'unknown').length;
    const staleMs = Number(this.cfg.nagiosStaleMs) || 180000;
    const lastOk = adapterStatus.snapshot().nagios?.last_ok_at;
    const lastOkAgeMs = lastOk ? Date.now() - Date.parse(lastOk) : null;
    const freshness =
      lastOkAgeMs == null
        ? 'unknown'
        : lastOkAgeMs > staleMs
          ? 'stale'
          : 'fresh';

    this.lastSnapshot = {
      hosts_total: hosts.length,
      hosts_down: hostsDown,
      services_total: services.length,
      services_critical: svcCritical,
      services_warning: svcWarning,
      services_unknown: svcUnknown,
      last_event_at: this.lastEventAt,
      freshness,
      integration_health:
        freshness === 'stale' ? 'stale' : freshness === 'fresh' ? 'ok' : 'unknown',
    };
    adapterStatus.recordMeta('nagios', this.lastSnapshot);
    return this.lastSnapshot;
  }

  async pollOnce() {
    try {
      const [hostsBody, svcsBody] = await Promise.all([
        this._getJson('hostlist'),
        this._getJson('servicelist'),
      ]);
      const hostOk = hostsBody?.result?.type_code === 0;
      const svcOk = svcsBody?.result?.type_code === 0;
      if (!hostOk || !svcOk) {
        adapterStatus.recordPoll('nagios', { ok: false, error: 'nagios_query_failed' });
        adapterStatus.recordMeta('nagios', {
          ...(this.lastSnapshot || {}),
          freshness: 'monitoring_unavailable',
          integration_health: 'error',
          last_error: 'nagios_query_failed',
        });
        logger.warn('nagios_adapter_query_failed', {
          host_code: hostsBody?.result?.type_code,
          svc_code: svcsBody?.result?.type_code,
        });
        return;
      }

      this.applyHostlist(hostsBody.data?.hostlist || {});
      this.applyServicelist(svcsBody.data?.servicelist || {});

      adapterStatus.recordPoll('nagios', { ok: true, status: 200 });
      const snap = this._publishSnapshot();
      logger.info('nagios_adapter_ingested', {
        hosts: snap.hosts_total,
        hosts_down: snap.hosts_down,
        services: snap.services_total,
        services_critical: snap.services_critical,
        services_warning: snap.services_warning,
        freshness: snap.freshness,
      });
    } catch (e) {
      adapterStatus.recordPoll('nagios', {
        ok: false,
        status: e && e.status,
        error: e && (e.name || e.message),
      });
      adapterStatus.recordMeta('nagios', {
        ...(this.lastSnapshot || {}),
        freshness: 'monitoring_unavailable',
        integration_health: 'error',
        last_error: e && (e.name || e.message),
      });
      logger.warn('nagios_adapter_error', { name: e && e.name, message: e && e.message });
    }
  }

  start() {
    adapterStatus.setEnabled('nagios', this.cfg.enableNagiosAdapter);
    if (!this.cfg.enableNagiosAdapter) {
      adapterStatus.recordMeta('nagios', {
        freshness: 'disabled',
        integration_health: 'disabled',
      });
      logger.info('nagios_adapter_disabled');
      return;
    }
    const tick = () => this.pollOnce().catch(() => {});
    tick();
    this.timer = setInterval(tick, this.cfg.nagiosPollMs);
    if (this.timer.unref) this.timer.unref();
    logger.info('nagios_adapter_started', {
      interval_ms: this.cfg.nagiosPollMs,
      url_host: (() => {
        try { return new URL(this.cfg.nagiosStatusjsonUrl).host; } catch (_) { return null; }
      })(),
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  NagiosAdapter,
  hostBucket,
  serviceBucket,
  hostIpFromName,
  HOST,
  SVC,
};
