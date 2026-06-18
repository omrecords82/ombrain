'use strict';

/**
 * Fleet platform health score — mirrors OMAI CP overview (helpers.computePlatformHealth)
 * using inventory summary fields only (no platform-status / overview extras).
 */

function computeFleetHealthFromSummary(summary) {
  if (!summary) {
    return { score: null, severity: 'unknown', detail: 'Awaiting inventory' };
  }

  let points = 100;
  const notes = [];

  if (summary.unreachable) {
    points -= 25 * Math.min(summary.unreachable, 4);
    notes.push(`${summary.unreachable} unreachable`);
  }
  if (summary.services_failed) {
    points -= 15 * Math.min(summary.services_failed, 3);
    notes.push(`${summary.services_failed} failed svc`);
  }
  if (summary.degraded) {
    points -= 10 * Math.min(summary.degraded, 3);
    notes.push(`${summary.degraded} degraded host`);
  }
  if (summary.critical_alerts) {
    points -= 8 * Math.min(summary.critical_alerts, 4);
    notes.push(`${summary.critical_alerts} critical alerts`);
  }

  const score = Math.max(0, Math.min(100, points));
  const severity = score < 60 ? 'critical' : score < 85 ? 'degraded' : 'healthy';
  return { score, severity, detail: notes.length ? notes.join(' · ') : 'All checks passing' };
}

function diffHostStatuses(prevMap, servers) {
  const recovered = [];
  const degraded = [];
  if (!prevMap || !servers) return { recovered, degraded };

  for (const server of servers) {
    const prev = prevMap[server.id];
    const next = server.status;
    if (!prev || prev === next) continue;
    if (prev === 'unreachable' && (next === 'online' || next === 'degraded')) {
      recovered.push({ id: server.id, hostname: server.hostname, from: prev, to: next });
    } else if (next === 'unreachable' && prev !== 'unreachable') {
      degraded.push({ id: server.id, hostname: server.hostname, from: prev, to: next });
    }
  }
  return { recovered, degraded };
}

module.exports = { computeFleetHealthFromSummary, diffHostStatuses };
