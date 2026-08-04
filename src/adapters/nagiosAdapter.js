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

class NagiosAdapter {
  constructor(deps = {}) {
    this.db = deps.db;
    this.fetch = deps.fetchImpl || globalThis.fetch;
    this.timer = null;
    this.cfg = config.ingest;
    this.prevHosts = null;
    this.prevServices = null;
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

  _insert(eventType, severity, payload) {
    const safe = redactForLog(payload);
    const identity = resolveTargetIdentity(eventType, safe);
    if (identity.registry_resolution) {
      safe.registry_resolution = identity.registry_resolution;
    }
    this.db &&
      this.db.insertEvent({
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
  }

  _emitHostTransitions(hostlist) {
    const next = {};
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
      this._insert(eventType, severity, {
        event_type: eventType,
        category: 'system',
        severity,
        source_system: 'nagios',
        title: becameBad
          ? `Host unreachable: ${name}`
          : `Host recovered: ${name}`,
        message: `${name} (${ip || 'ip unknown'}) Nagios host ${prev.bucket} → ${bucket}. ${row.plugin_output || ''}`.trim(),
        event_payload: {
          host_id: name,
          hostname: name,
          from: prev.bucket,
          to: bucket,
          reason: row.plugin_output || null,
          nagios_status: row.status,
          last_check: msToIso(row.last_check),
          target_name: name,
          target_host: name,
          target_ip: ip,
          check_method: 'nagios',
          checked_from: this.cfg.nagiosCheckedFrom,
        },
        nagios_object: `host:${name}`,
      });
    }
    this.prevHosts = next;
  }

  _emitServiceTransitions(servicelist) {
    const next = {};
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

        const becameBad = (bucket === 'critical' || bucket === 'warning') &&
          prev.bucket !== 'critical' && prev.bucket !== 'warning';
        const recovered = (prev.bucket === 'critical' || prev.bucket === 'warning') &&
          bucket === 'ok';
        if (!becameBad && !recovered) continue;

        const eventType = becameBad ? 'service.unhealthy' : 'service.recovered';
        const severity = bucket === 'critical' ? 'critical' : (becameBad ? 'warning' : 'success');
        this._insert(eventType, severity, {
          event_type: eventType,
          category: 'system',
          severity,
          source_system: 'nagios',
          title: `${svcName} on ${hostName}: ${bucket}`,
          message: `${hostName}/${svcName} Nagios ${prev.bucket} → ${bucket}. ${row.plugin_output || ''}`.trim(),
          event_payload: {
            host_id: hostName,
            hostname: hostName,
            service: svcName,
            from: prev.bucket,
            to: bucket,
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
          nagios_object: `service:${key}`,
        });
      }
    }
    this.prevServices = next;
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
        logger.warn('nagios_adapter_query_failed', {
          host_code: hostsBody?.result?.type_code,
          svc_code: svcsBody?.result?.type_code,
        });
        return;
      }

      this._emitHostTransitions(hostsBody.data?.hostlist || {});
      this._emitServiceTransitions(svcsBody.data?.servicelist || {});

      const hostCount = Object.keys(this.prevHosts || {}).length;
      const down = Object.values(this.prevHosts || {}).filter((h) => h.bucket === 'down').length;
      adapterStatus.recordPoll('nagios', { ok: true, status: 200 });
      logger.info('nagios_adapter_ingested', { hosts: hostCount, hosts_down: down });
    } catch (e) {
      adapterStatus.recordPoll('nagios', {
        ok: false,
        status: e && e.status,
        error: e && (e.name || e.message),
      });
      logger.warn('nagios_adapter_error', { name: e && e.name, message: e && e.message });
    }
  }

  start() {
    adapterStatus.setEnabled('nagios', this.cfg.enableNagiosAdapter);
    if (!this.cfg.enableNagiosAdapter) {
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
