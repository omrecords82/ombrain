'use strict';

/**
 * Nagios status adapter (READ-ONLY).
 *
 * Polls Nagios Core JSON CGIs and emits host/service hard-state observations
 * into event_memory. Nagios is the monitoring source of truth for fleet health.
 *
 * First successful poll performs initial-state reconciliation for objects
 * already in a hard non-healthy state (no fabricated prior OK transition).
 * Subsequent polls emit only real state transitions.
 */

const fs = require('fs');
const { config } = require('../config');
const { redactForLog } = require('../ai/redactor');
const adapterStatus = require('../health/adapterStatus');
const { resolveTargetIdentity } = require('../ingest/eventIdentity');
const { resolveNagiosResourceIdentity } = require('../ingest/nagiosResourceIdentity');
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

function isSyntheticNagiosObject(name, serviceName) {
  const blob = `${name || ''}|${serviceName || ''}`.toLowerCase();
  return blob.includes('ombrain-fixture') || blob.includes('fixture');
}

function readSecretFile(filePath) {
  if (!filePath) return '';
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (_) {
    return '';
  }
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
    this._recentKeys = new Set();
    this.reconciliationStats = {
      last_run_at: null,
      hosts_reconciled: 0,
      services_reconciled: 0,
      incidents_created: 0,
      incidents_reused: 0,
      duplicates_prevented: 0,
      downtime_suppressed: 0,
    };
    this.authState = {
      method: null,
      configured: false,
      last_result: 'not_attempted',
      last_error: null,
    };
  }

  _authHeaders() {
    const user = this.cfg.nagiosStatusUser || '';
    const pass =
      this.cfg.nagiosStatusPassword ||
      readSecretFile(this.cfg.nagiosStatusPasswordFile);
    if (!user || !pass) {
      this.authState = {
        method: this.cfg.nagiosAuthRequired ? 'basic_required' : 'none',
        configured: false,
        last_result: this.cfg.nagiosAuthRequired ? 'missing_credentials' : 'not_configured',
        last_error: this.cfg.nagiosAuthRequired ? 'missing_credentials' : null,
      };
      return {};
    }
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    this.authState = {
      method: 'basic',
      configured: true,
      last_result: 'configured',
      last_error: null,
      service_identity: user,
    };
    return { Authorization: `Basic ${token}` };
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
    if (this.cfg.nagiosAuthRequired) {
      const user = this.cfg.nagiosStatusUser || '';
      const pass =
        this.cfg.nagiosStatusPassword ||
        readSecretFile(this.cfg.nagiosStatusPasswordFile);
      if (!user || !pass) {
        const err = new Error('nagios_auth_credentials_missing');
        err.status = 401;
        err.code = 'auth_missing';
        throw err;
      }
    }
    const headers = {
      Accept: 'application/json',
      ...this._authHeaders(),
    };
    const res = await this.fetch(this._url(query), { headers });
    if (res.status === 401 || res.status === 403) {
      this.authState.last_result = 'auth_failed';
      this.authState.last_error = `http_${res.status}`;
      const err = new Error(`http_${res.status}`);
      err.status = res.status;
      err.code = 'auth_failed';
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`http_${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (this.authState.configured) {
      this.authState.last_result = 'ok';
      this.authState.last_error = null;
    }
    return res.json();
  }

  _idempotencyKey(nagiosObject, eventType, from, to, origin) {
    if (origin === 'initial_reconciliation') {
      return `${nagiosObject}|${eventType}|initial_reconciliation|${to}`;
    }
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
        this.reconciliationStats.duplicates_prevented += 1;
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
        this.reconciliationStats.duplicates_prevented += 1;
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
        target_name: identity.target_name || safe.resource_identity?.canonical_hostname || null,
        target_ip: identity.target_ip || safe.resource_identity?.ip_address || null,
        target_host: identity.target_host || safe.resource_identity?.canonical_hostname || safe.monitored_host || null,
        target_service: identity.target_service || safe.monitored_service || null,
        check_method: identity.check_method || 'nagios',
        checked_from: identity.checked_from || this.cfg.nagiosCheckedFrom,
        target_identity_status: identity.target_identity_status || safe.resource_identity?.mapping_status || null,
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

    if (correlation && correlation.action === 'opened_incident') {
      this.reconciliationStats.incidents_created += 1;
    } else if (correlation && correlation.action === 'updated_open_incident') {
      this.reconciliationStats.incidents_reused += 1;
    } else if (correlation && correlation.action === 'suppressed_downtime') {
      this.reconciliationStats.downtime_suppressed += 1;
    }

    logger.info('nagios_event_ingested', {
      event_type: eventType,
      severity,
      nagios_object: safe.nagios_object,
      event_id: eventId,
      incident_action: correlation && correlation.action,
      observation_origin: safe.observation_origin || null,
      synthetic: !!safe.synthetic,
    });

    return { inserted: true, id: eventId, correlation };
  }

  _attachResourceIdentity(payload, hostName, ip, serviceName) {
    const resource = resolveNagiosResourceIdentity({
      nagiosHostName: hostName,
      ip,
      serviceName: serviceName || null,
    });
    payload.resource_identity = resource;
    payload.normalized_resource_identity = resource.canonical_resource_id;
    if (payload.event_payload && typeof payload.event_payload === 'object') {
      payload.event_payload.canonical_hostname = resource.canonical_hostname;
      payload.event_payload.mapping_status = resource.mapping_status;
      payload.event_payload.role = resource.role;
      payload.event_payload.environment = resource.environment;
    }
    if (resource.canonical_hostname) {
      payload.title = payload.title
        ? payload.title.replace(hostName, `${resource.canonical_hostname} (${hostName})`)
        : payload.title;
    }
    return payload;
  }

  _buildHostPayload({ name, ip, row, prev, bucket, eventType, severity, origin }) {
    const nagiosObject = `host:${name}`;
    const from = prev && prev.bucket != null ? prev.bucket : 'absent';
    const to = bucket;
    const synthetic = isSyntheticNagiosObject(name, null);
    const observedAt = new Date().toISOString();
    const nagiosTs = msToIso(row.last_check);
    const payload = {
      event_id: null,
      source_system: 'nagios',
      source_host: this.cfg.nagiosCheckedFrom,
      monitored_host: name,
      monitored_service: null,
      timestamp: nagiosTs || observedAt,
      nagios_state_timestamp: nagiosTs,
      ombrain_observation_timestamp: observedAt,
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
        last_check: nagiosTs,
        target_name: name,
        target_host: name,
        target_ip: ip,
        check_method: 'nagios',
        checked_from: this.cfg.nagiosCheckedFrom,
      },
      nagios_object: nagiosObject,
      observation_origin: origin || 'transition',
      synthetic,
      transition_observed: origin !== 'initial_reconciliation',
      idempotency_key: this._idempotencyKey(
        nagiosObject,
        eventType,
        from,
        to,
        origin || 'transition',
      ),
    };
    return this._attachResourceIdentity(payload, name, ip, null);
  }

  _buildServicePayload({ hostName, svcName, ip, row, prev, bucket, eventType, severity, origin }) {
    const key = `${hostName}::${svcName}`;
    const nagiosObject = `service:${key}`;
    const from = prev && prev.bucket != null ? prev.bucket : 'absent';
    const to = bucket;
    const synthetic = isSyntheticNagiosObject(hostName, svcName);
    const observedAt = new Date().toISOString();
    const nagiosTs = msToIso(row.last_check);
    const payload = {
      event_id: null,
      source_system: 'nagios',
      source_host: this.cfg.nagiosCheckedFrom,
      monitored_host: hostName,
      monitored_service: svcName,
      timestamp: nagiosTs || observedAt,
      nagios_state_timestamp: nagiosTs,
      ombrain_observation_timestamp: observedAt,
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
        last_check: nagiosTs,
        target_name: hostName,
        target_host: hostName,
        target_ip: ip,
        target_service: svcName,
        check_method: 'nagios',
        checked_from: this.cfg.nagiosCheckedFrom,
      },
      nagios_object: nagiosObject,
      observation_origin: origin || 'transition',
      synthetic,
      transition_observed: origin !== 'initial_reconciliation',
      idempotency_key: this._idempotencyKey(
        nagiosObject,
        eventType,
        from,
        to,
        origin || 'transition',
      ),
    };
    return this._attachResourceIdentity(payload, hostName, ip, svcName);
  }

  /**
   * Apply a hostlist snapshot.
   * First call: initial-state reconciliation for hard non-healthy hosts.
   * Later calls: emit only real state transitions.
   */
  applyHostlist(hostlist) {
    const next = {};
    const emitted = [];
    const initial = !this.prevHosts;
    for (const [name, row] of Object.entries(hostlist || {})) {
      if (!row || typeof row !== 'object') continue;
      const bucket = hostBucket(row.status);
      const ip = hostIpFromName(name);
      const inDowntime =
        row.scheduled_downtime_depth != null &&
        Number(row.scheduled_downtime_depth) > 0;
      next[name] = {
        bucket,
        status: row.status,
        output: row.plugin_output || '',
        ip,
        downtime: inDowntime,
        acknowledged: !!row.problem_has_been_acknowledged,
      };

      if (initial) {
        // Hard non-healthy only; do not fabricate a prior OK state.
        if (bucket !== 'down') continue;
        if (inDowntime && !this.cfg.nagiosReconcileDowntimeActionable) {
          this.reconciliationStats.downtime_suppressed += 1;
          continue;
        }
        const eventType = 'host.unreachable';
        const severity = 'critical';
        const payload = this._buildHostPayload({
          name,
          ip,
          row,
          prev: { bucket: 'absent' },
          bucket,
          eventType,
          severity,
          origin: 'initial_reconciliation',
        });
        const result = this._insert(eventType, severity, payload);
        this.reconciliationStats.hosts_reconciled += 1;
        emitted.push({ eventType, result, origin: 'initial_reconciliation' });
        continue;
      }

      const prev = this.prevHosts[name];
      if (!prev || prev.bucket === bucket) continue;

      const becameBad = bucket === 'down' && prev.bucket !== 'down';
      const recovered = prev.bucket === 'down' && bucket === 'up';
      if (!becameBad && !recovered) continue;

      if (becameBad && inDowntime && !this.cfg.nagiosReconcileDowntimeActionable) {
        this.reconciliationStats.downtime_suppressed += 1;
        continue;
      }

      const eventType = becameBad ? 'host.unreachable' : 'host.recovered';
      const severity = becameBad ? 'critical' : 'success';
      const payload = this._buildHostPayload({
        name, ip, row, prev, bucket, eventType, severity, origin: 'transition',
      });
      const result = this._insert(eventType, severity, payload);
      emitted.push({ eventType, result });
    }
    if (initial) this.reconciliationStats.last_run_at = new Date().toISOString();
    this.prevHosts = next;
    return emitted;
  }

  applyServicelist(servicelist) {
    const next = {};
    const emitted = [];
    const initial = !this.prevServices;
    for (const [hostName, services] of Object.entries(servicelist || {})) {
      if (!services || typeof services !== 'object') continue;
      for (const [svcName, row] of Object.entries(services)) {
        if (!row || typeof row !== 'object') continue;
        const key = `${hostName}::${svcName}`;
        const bucket = serviceBucket(row.status);
        const ip = hostIpFromName(hostName);
        const inDowntime =
          row.scheduled_downtime_depth != null &&
          Number(row.scheduled_downtime_depth) > 0;
        next[key] = {
          bucket,
          status: row.status,
          output: row.plugin_output || '',
          downtime: inDowntime,
          acknowledged: !!row.problem_has_been_acknowledged,
          synthetic: isSyntheticNagiosObject(hostName, svcName),
        };

        // Skip pure PING flaps when host-level events already cover reachability.
        if (svcName === 'PING') continue;

        if (initial) {
          // Hard non-healthy actionable states only (CRITICAL/WARNING).
          // UNKNOWN is not treated as confirmed healthy or confirmed bad for incidents.
          if (severityRank(bucket) < 2) continue;
          if (inDowntime && !this.cfg.nagiosReconcileDowntimeActionable) {
            this.reconciliationStats.downtime_suppressed += 1;
            continue;
          }
          const eventType = 'service.unhealthy';
          const severity = bucket === 'critical' ? 'critical' : 'warning';
          const payload = this._buildServicePayload({
            hostName,
            svcName,
            ip,
            row,
            prev: { bucket: 'absent' },
            bucket,
            eventType,
            severity,
            origin: 'initial_reconciliation',
          });
          const result = this._insert(eventType, severity, payload);
          this.reconciliationStats.services_reconciled += 1;
          emitted.push({ eventType, result, origin: 'initial_reconciliation' });
          continue;
        }

        const prev = this.prevServices[key];
        if (!prev || prev.bucket === bucket) continue;

        const becameBad =
          severityRank(bucket) >= 2 && severityRank(prev.bucket) < 2;
        const recovered =
          severityRank(prev.bucket) >= 2 && bucket === 'ok';
        const escalated =
          prev.bucket === 'warning' && bucket === 'critical';
        const deescalated =
          prev.bucket === 'critical' && bucket === 'warning';
        if (!becameBad && !recovered && !escalated && !deescalated) continue;

        if (becameBad && inDowntime && !this.cfg.nagiosReconcileDowntimeActionable) {
          this.reconciliationStats.downtime_suppressed += 1;
          continue;
        }

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
          hostName, svcName, ip, row, prev, bucket, eventType, severity, origin: 'transition',
        });
        const result = this._insert(eventType, severity, payload);
        emitted.push({ eventType, result });
      }
    }
    this.prevServices = next;
    return emitted;
  }

  _mappingSummary() {
    const hosts = Object.entries(this.prevHosts || {});
    let mapped = 0;
    let unmapped = 0;
    const gaps = [];
    for (const [name, row] of hosts) {
      const id = resolveNagiosResourceIdentity({
        nagiosHostName: name,
        ip: row.ip,
      });
      if (id.mapping_status === 'mapped') mapped += 1;
      else {
        unmapped += 1;
        gaps.push({ nagios_object: name, ip: row.ip || null });
      }
    }
    return { mapped, unmapped, unmapped_hosts: gaps.slice(0, 50) };
  }

  _publishSnapshot() {
    const hosts = Object.values(this.prevHosts || {});
    const services = Object.values(this.prevServices || {});
    const hostsDown = hosts.filter((h) => h.bucket === 'down').length;
    const svcCritical = services.filter((s) => s.bucket === 'critical' && !s.synthetic).length;
    const svcWarning = services.filter((s) => s.bucket === 'warning' && !s.synthetic).length;
    const svcUnknown = services.filter((s) => s.bucket === 'unknown').length;
    const svcSynthetic = services.filter((s) => s.synthetic).length;
    const staleMs = Number(this.cfg.nagiosStaleMs) || 180000;
    const lastOk = adapterStatus.snapshot().nagios?.last_ok_at;
    const lastOkAgeMs = lastOk ? Date.now() - Date.parse(lastOk) : null;
    const freshness =
      lastOkAgeMs == null
        ? 'unknown'
        : lastOkAgeMs > staleMs
          ? 'stale'
          : 'fresh';

    const mapping = this._mappingSummary();
    this.lastSnapshot = {
      hosts_total: hosts.length,
      hosts_down: hostsDown,
      services_total: services.length,
      services_critical: svcCritical,
      services_warning: svcWarning,
      services_unknown: svcUnknown,
      services_synthetic_excluded: svcSynthetic,
      last_event_at: this.lastEventAt,
      freshness,
      integration_health:
        freshness === 'stale' ? 'stale' : freshness === 'fresh' ? 'ok' : 'unknown',
      reconciliation: { ...this.reconciliationStats },
      mapping,
      authentication: {
        method: this.authState.method,
        configured: this.authState.configured,
        last_result: this.authState.last_result,
        service_identity: this.authState.service_identity || null,
        // never include secrets
      },
      notification: this.cfg.nagiosNotificationStatus || {
        status: 'unverified',
        last_tested_at: null,
      },
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
        reconciled_hosts: snap.reconciliation?.hosts_reconciled,
        reconciled_services: snap.reconciliation?.services_reconciled,
      });
    } catch (e) {
      const authFail = e && (e.code === 'auth_failed' || e.code === 'auth_missing' || e.status === 401 || e.status === 403);
      adapterStatus.recordPoll('nagios', {
        ok: false,
        status: e && e.status,
        error: e && (e.name || e.message),
        state: authFail ? 'auth_error' : undefined,
      });
      adapterStatus.recordMeta('nagios', {
        ...(this.lastSnapshot || {}),
        freshness: 'monitoring_unavailable',
        integration_health: authFail ? 'auth_failed' : 'error',
        last_error: e && (e.name || e.message),
        authentication: {
          method: this.authState.method,
          configured: this.authState.configured,
          last_result: this.authState.last_result,
          service_identity: this.authState.service_identity || null,
        },
      });
      logger.warn('nagios_adapter_error', {
        name: e && e.name,
        message: e && e.message,
        auth_failed: !!authFail,
      });
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
      auth_required: !!this.cfg.nagiosAuthRequired,
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
  isSyntheticNagiosObject,
  HOST,
  SVC,
};
