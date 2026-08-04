'use strict';

/**
 * Canonical Nagios → inventory identity mapping.
 *
 * Single authoritative source: inventory/hosts.json via fleet/hosts.resolveHost.
 * Preserves Nagios object name + IP as evidence; never invents a hostname.
 */

let resolveHost = null;
try {
  // eslint-disable-next-line global-require
  ({ resolveHost } = require('../fleet/hosts'));
} catch (_) {
  resolveHost = null;
}

function hostIpFromName(name) {
  const m = String(name || '').match(/^host-(\d+)-(\d+)-(\d+)-(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : null;
}

/**
 * Resolve IP for a Nagios host object name.
 * Prefers explicit IP, then host-A-B-C-D pattern, then inventory/hosts.json by name.
 */
function resolveNagiosHostIp(name, explicitIp) {
  if (explicitIp && String(explicitIp).trim()) return String(explicitIp).trim();
  const fromPattern = hostIpFromName(name);
  if (fromPattern) return fromPattern;
  if (resolveHost && name) {
    try {
      const hit = resolveHost(String(name).trim());
      if (hit && hit.ip) return hit.ip;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.nagiosHostName  e.g. host-192-168-1-254
 * @param {string|null} [opts.ip]
 * @param {string|null} [opts.serviceName]
 * @returns {object} normalized monitored resource identity
 */
function resolveNagiosResourceIdentity(opts = {}) {
  const nagiosHostName = String(opts.nagiosHostName || '').trim();
  const serviceName = opts.serviceName != null ? String(opts.serviceName) : null;
  const ip = resolveNagiosHostIp(nagiosHostName, opts.ip);

  let hit = null;
  if (resolveHost) {
    const handles = [ip, nagiosHostName].filter(Boolean);
    for (const h of handles) {
      try {
        hit = resolveHost(h);
        if (hit) break;
      } catch (_) {
        hit = null;
      }
    }
  }

  const mapped = Boolean(hit && hit.name);
  return {
    canonical_resource_id: mapped
      ? serviceName
        ? `inventory/${hit.name}/service/${serviceName}`
        : `inventory/${hit.name}`
      : serviceName
        ? `nagios/service/${nagiosHostName}::${serviceName}`
        : `nagios/host/${nagiosHostName}`,
    canonical_hostname: mapped ? hit.name : null,
    nagios_object_name: nagiosHostName || null,
    ip_address: ip,
    environment: mapped ? hit.environment || null : null,
    role: mapped ? hit.role || null : null,
    component: serviceName || (mapped ? hit.role || null : null),
    owning_system: mapped ? hit.name : null,
    inventory_source: mapped ? 'inventory/hosts.json' : null,
    mapping_status: mapped ? 'mapped' : nagiosHostName ? 'unmapped' : 'unknown',
    registry_name: mapped ? hit.name : null,
    registry_ip: mapped ? hit.ip || null : null,
  };
}

module.exports = {
  resolveNagiosResourceIdentity,
  hostIpFromName,
  resolveNagiosHostIp,
};
