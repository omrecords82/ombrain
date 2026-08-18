'use strict';

/**
 * OMBrain Operator Briefing Model.
 *
 * Synthesizes existing om-brain read surfaces (health, status, governance,
 * skills, actions, decisions, event ledger) plus the console's own activity
 * log into operator conclusions: a verdict, an action queue, what changed,
 * capability readiness, and clustered/classified events.
 *
 * Every field traces back to a real probe result. When a source is
 * unavailable, it is reported as such (ok:false / state:'unknown') — nothing
 * here is fabricated. Heuristic synthesis (clustering, classification,
 * plain-language headlines) is explicitly derived from the real payloads
 * returned in this same request.
 */

const { brainGet } = require('./brainClient');
const activityLog = require('./activityLog');

const CONSOLE_STARTED_AT = new Date().toISOString();

/** Per-process memory — resets on service restart. Documented, not hidden. */
let previousSnapshot = null;
const incidentTracker = new Map(); // id -> { first_seen, last_seen }

const SOURCES = [
  { key: 'health', label: 'Brain health', endpoint: '/health' },
  { key: 'status', label: 'Runtime status', endpoint: '/status' },
  { key: 'governance', label: 'Governance health', endpoint: '/governance/health' },
  { key: 'skills', label: 'Skills registry', endpoint: '/brain/skills' },
  { key: 'actions', label: 'Actions registry', endpoint: '/brain/actions' },
  { key: 'decisions', label: 'Decision ledger', endpoint: '/decisions?limit=20' },
  { key: 'events', label: 'Event ledger', endpoint: '/audit/findings?limit=200' },
];

async function fetchAllSources() {
  const results = await Promise.all(SOURCES.map((s) => brainGet(s.endpoint)));
  const byKey = {};
  SOURCES.forEach((s, i) => {
    byKey[s.key] = results[i];
  });
  return byKey;
}

function buildRawSourceStatus(byKey, checkedAt) {
  return SOURCES.map((s) => {
    const r = byKey[s.key];
    return {
      source: s.key,
      label: s.label,
      endpoint: s.endpoint,
      ok: Boolean(r.ok),
      status_code: r.status,
      latency_ms: r.latencyMs,
      error: r.error,
      checked_at: checkedAt,
    };
  });
}

function resolveLlmStatus(health) {
  if (health?.llm?.status) return String(health.llm.status);
  if (health?.llm_endpoint_allowed === true) return 'available';
  if (health?.llm_endpoint_allowed === false) return 'disabled';
  return 'unknown';
}

function buildHealthVerdict(byKey) {
  const health = byKey.health.ok ? byKey.health.json : null;
  const status = byKey.status.ok ? byKey.status.json : null;
  const gov = byKey.governance.ok ? byKey.governance.json : null;
  const skills = byKey.skills.ok ? byKey.skills.json : null;

  const brain_online = Boolean(byKey.health.ok && health && health.ok !== false);
  const console_proxy_online = true; // this code is executing inside the console process
  const llm_status = resolveLlmStatus(health || gov || {});
  const llm_available = llm_status === 'available';
  const executesActions = health?.executes_actions ?? gov?.executes_actions ?? status?.executes_actions ?? false;
  const governance_mode = !brain_online ? 'unknown' : executesActions ? 'executes' : 'auditor';

  let skills_registered = null;
  if (skills) {
    if (typeof skills.count === 'number') skills_registered = skills.count;
    else if (Array.isArray(skills.skills)) skills_registered = skills.skills.length;
  }

  const recentActivity = activityLog.listBrainActivity(1).activity[0];
  const last_action_latency_ms = recentActivity ? recentActivity.latency_ms : byKey.health.latencyMs ?? null;

  let verdict = 'nominal';
  let reason = 'Core subsystems (health, governance, skills, actions) are all reachable and reporting healthy.';

  const degradedReasons = [];
  if (!brain_online) {
    verdict = 'offline';
    reason = byKey.health.error
      ? `om-brain upstream unreachable: ${byKey.health.error}`
      : 'om-brain health probe did not return a healthy payload.';
  } else {
    if (!llm_available) degradedReasons.push(`LLM circuit is ${llm_status}`);
    if (!byKey.skills.ok) degradedReasons.push('skills registry did not respond');
    if (!byKey.actions.ok) degradedReasons.push('actions registry did not respond');
    if (!byKey.governance.ok) degradedReasons.push('governance health did not respond');
    if (!byKey.events.ok) degradedReasons.push('event ledger did not respond');

    const nagios = status?.nagios_monitoring;
    if (nagios?.enabled) {
      const freshness = String(nagios.freshness || 'unknown');
      if (
        freshness === 'stale' ||
        freshness === 'monitoring_unavailable' ||
        freshness === 'unknown' ||
        nagios.adapter_state === 'error'
      ) {
        degradedReasons.push(
          `Nagios monitoring is ${freshness === 'fresh' ? nagios.adapter_state : freshness} (not healthy)`,
        );
      }
    }

    if (degradedReasons.length) {
      verdict = 'degraded';
      reason = `Brain is reachable, but ${degradedReasons.join('; ')}.`;
    }
  }

  return {
    brain_online,
    console_proxy_online,
    llm_available,
    governance_mode,
    skills_registered,
    last_action_latency_ms,
    verdict,
    reason,
    _llm_status: llm_status, // internal, consumed by executive summary / actions below
  };
}

function buildOperatorActions(byKey, healthVerdict, eventClusters) {
  const actions = [];

  if (healthVerdict.verdict === 'offline') {
    actions.push({
      id: 'brain-offline',
      severity: 'critical',
      title: 'om-brain upstream is unreachable',
      explanation: healthVerdict.reason,
      recommended_action: 'Check the om-brain service on om-dev (.254:8390) and review recent deploys or restarts.',
      button_label: 'Open diagnostics',
      navigate_to: 'diagnostics',
      safe_to_act: true,
    });
  }

  if (healthVerdict.brain_online && !healthVerdict.llm_available) {
    const critical = healthVerdict._llm_status === 'error';
    actions.push({
      id: 'llm-unavailable',
      severity: critical ? 'critical' : 'warning',
      title: `LLM circuit is ${healthVerdict._llm_status}`,
      explanation:
        'Ask Brain and Theology answers that depend on generative inference will degrade to retrieval-only or fail.',
      recommended_action: critical
        ? 'Check the local inference gateway logs on om-dev and confirm the model process is running.'
        : 'Review the circuit breaker reason on om-dev; LLM-backed answers are degraded until it clears.',
      button_label: 'Ask Brain',
      navigate_to: 'ask',
      safe_to_act: true,
    });
  }

  if (!byKey.skills.ok) {
    actions.push({
      id: 'skills-unreachable',
      severity: 'warning',
      title: 'Skills registry did not respond',
      explanation: `GET /brain/skills failed (${byKey.skills.error || `status ${byKey.skills.status}`}). Skill counts and registration may be stale.`,
      recommended_action: 'Open Skills and refresh manually to confirm whether this is transient.',
      button_label: 'Open Skills',
      navigate_to: 'skills',
      safe_to_act: true,
    });
  }

  if (!byKey.actions.ok) {
    actions.push({
      id: 'actions-unreachable',
      severity: 'warning',
      title: 'Actions registry did not respond',
      explanation: `GET /brain/actions failed (${byKey.actions.error || `status ${byKey.actions.status}`}). Infrastructure actions may be unavailable.`,
      recommended_action: 'Open Actions and refresh manually to confirm whether this is transient.',
      button_label: 'Open Actions',
      navigate_to: 'actions',
      safe_to_act: true,
    });
  }

  const statusJson = byKey.status.ok ? byKey.status.json : null;
  const nagios = statusJson?.nagios_monitoring;
  if (nagios?.enabled) {
    const freshness = String(nagios.freshness || 'unknown');
    const authFailed =
      nagios.adapter_state === 'auth_error' ||
      nagios.integration_health === 'auth_failed' ||
      nagios.authentication?.last_result === 'auth_failed';
    if (
      freshness === 'stale' ||
      freshness === 'monitoring_unavailable' ||
      freshness === 'unknown' ||
      nagios.adapter_state === 'error' ||
      authFailed
    ) {
      actions.push({
        id: 'nagios-monitoring-unavailable',
        severity: freshness === 'stale' ? 'warning' : 'critical',
        title: authFailed
          ? 'Nagios status authentication failed'
          : 'Nagios monitoring freshness is not healthy',
        explanation: authFailed
          ? `Nagios status access failed authentication (freshness=${freshness}). Monitoring must be reported unavailable, not healthy.`
          : `Nagios adapter state=${nagios.adapter_state || 'unknown'}, freshness=${freshness}. Missing or stale monitoring must not be treated as healthy.`,
        recommended_action: authFailed
          ? 'Verify BRAIN_NAGIOS_STATUS_USER / password file and the local status proxy on 127.0.0.1:18080.'
          : 'Verify Nagios on ops (.40:8080/nagios4), BRAIN_ENABLE_NAGIOS_ADAPTER, and recent om-brain logs for nagios_adapter_*.',
        button_label: 'Open diagnostics',
        navigate_to: 'diagnostics',
        safe_to_act: true,
      });
    } else if ((nagios.hosts_down || 0) > 0 || (nagios.services_critical || 0) > 0) {
      actions.push({
        id: 'nagios-active-problems',
        severity: 'warning',
        title: `Nagios reports ${nagios.hosts_down || 0} host(s) down, ${nagios.services_critical || 0} critical service(s)`,
        explanation:
          'Live Nagios statusjson shows active problems (synthetic fixtures excluded from totals). Review the Event Ledger for nagios-sourced observations including initial_reconciliation.',
        recommended_action: 'Open Events and filter source=nagios; correlate with Nagios UI on ops.',
        button_label: 'Open events',
        navigate_to: 'events',
        safe_to_act: true,
      });
    }
    if ((nagios.mapping?.unmapped || 0) > 0) {
      actions.push({
        id: 'nagios-unmapped-resources',
        severity: 'info',
        title: `${nagios.mapping.unmapped} Nagios host(s) lack canonical inventory mapping`,
        explanation: 'Unmapped Nagios objects remain visible with mapping_status=unmapped; hostnames are not invented.',
        recommended_action: 'Extend inventory/hosts.json aliases for the unmapped IPs, then restart om-brain.',
        button_label: 'Open diagnostics',
        navigate_to: 'diagnostics',
        safe_to_act: true,
      });
    }
    const n = nagios.notification || {};
    const nStatus = String(n.overall_status || n.status || 'unverified');
    if (nStatus === 'failed' || nStatus === 'degraded' || nStatus === 'unverified' || nStatus === 'unconfigured') {
      const receipt = n.operator_receipt || 'unverified';
      const transport = n.external_transport || 'unconfigured';
      actions.push({
        id: 'nagios-notification-status',
        severity: nStatus === 'failed' ? 'warning' : 'info',
        title: `Nagios notification delivery is ${nStatus}`,
        explanation: n.detail ||
          `Local sink success is not operator delivery. transport=${transport}; operator_receipt=${receipt}.`,
        recommended_action:
          'Confirm operator inbox receipt of a controlled Nagios alert, then set BRAIN_NAGIOS_NOTIFICATION_OPERATOR_RECEIPT=verified (overall remains degraded until then).',
        button_label: 'Open diagnostics',
        navigate_to: 'diagnostics',
        safe_to_act: true,
      });
    }
  }

  if (!byKey.governance.ok) {
    actions.push({
      id: 'governance-unreachable',
      severity: 'info',
      title: 'Governance health endpoint did not respond',
      explanation: `GET /governance/health failed (${byKey.governance.error || `status ${byKey.governance.status}`}).`,
      recommended_action: 'Non-blocking — governance posture falls back to the primary health probe.',
      button_label: 'Open Governance',
      navigate_to: 'governance',
      safe_to_act: true,
    });
  }

  for (const cluster of eventClusters) {
    if (cluster.classification_summary !== 'requires_attention') continue;
    actions.push({
      id: `event-cluster-${cluster.id}`,
      severity: cluster.severity === 'critical' ? 'critical' : 'warning',
      title: cluster.title,
      explanation: cluster.impact,
      recommended_action: cluster.recommended_action,
      button_label: 'View event ledger',
      navigate_to: 'events',
      safe_to_act: true,
    });
  }

  if (!actions.length) {
    actions.push({
      id: 'all-clear',
      severity: 'info',
      title: 'No critical issues detected',
      explanation: 'All probed subsystems responded successfully on this check.',
      recommended_action: 'No action needed — keep monitoring the status strip.',
      safe_to_act: true,
    });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return actions.sort((a, b) => order[a.severity] - order[b.severity]);
}

function trackIncidents(operatorActions, nowIso) {
  const activeIds = new Set();
  for (const action of operatorActions) {
    if (action.severity !== 'critical') continue;
    activeIds.add(action.id);
    if (incidentTracker.has(action.id)) {
      incidentTracker.get(action.id).last_seen = nowIso;
    } else {
      incidentTracker.set(action.id, { first_seen: nowIso, last_seen: nowIso });
    }
  }
  for (const key of Array.from(incidentTracker.keys())) {
    if (!activeIds.has(key)) incidentTracker.delete(key);
  }

  return operatorActions
    .filter((a) => a.severity === 'critical')
    .map((a) => ({
      id: a.id,
      title: a.title,
      explanation: a.explanation,
      recommended_action: a.recommended_action,
      first_seen: incidentTracker.get(a.id)?.first_seen ?? nowIso,
      last_seen: incidentTracker.get(a.id)?.last_seen ?? nowIso,
      navigate_to: a.navigate_to,
    }));
}

function buildRecentChanges(currentSnapshot, nowIso) {
  const changes = [];

  if (!previousSnapshot) {
    changes.push({
      id: 'change-baseline',
      summary: `Baseline snapshot captured (console process started ${CONSOLE_STARTED_AT}).`,
      observed_at: nowIso,
      severity: 'info',
    });
  } else {
    const diffs = [
      ['brain_online', 'om-brain reachability'],
      ['llm_status', 'LLM circuit status'],
      ['governance_mode', 'Governance mode'],
      ['skills_registered', 'Skills registered'],
    ];
    for (const [field, label] of diffs) {
      const before = previousSnapshot[field];
      const after = currentSnapshot[field];
      if (before !== after && before !== undefined) {
        changes.push({
          id: `change-${field}`,
          summary: `${label} changed: ${String(before)} → ${String(after)}`,
          observed_at: nowIso,
          severity: field === 'brain_online' && after === false ? 'critical' : 'info',
        });
      }
    }
    if (!changes.length) {
      changes.push({
        id: 'change-none',
        summary: 'No material state changes since the last check.',
        observed_at: nowIso,
        severity: 'info',
      });
    }
  }

  const recentOps = activityLog
    .listBrainActivity(10)
    .activity.filter((row) => !row.endpoint?.includes('/health') && !row.endpoint?.includes('/proxy-health'))
    .slice(0, 5)
    .map((row) => ({
      id: `change-activity-${row.request_id}`,
      summary: `${row.label || `${row.method} ${row.endpoint}`} — ${row.outcome}`,
      observed_at: row.timestamp,
      severity: row.outcome === 'error' ? 'warning' : 'info',
    }));

  return [...changes, ...recentOps];
}

const CAPABILITY_DEFS = [
  { id: 'ask', capability: 'Unified Ask', category: 'Ask / Knowledge', gate: 'Read-only' },
  { id: 'theology', capability: 'Theology / Knowledge RAG', category: 'Ask / Knowledge', gate: 'Proposal-only' },
  { id: 'calendar', capability: 'Calendar & Saints', category: 'Orthodox Calendar & Saints', gate: 'Read-only' },
  { id: 'churches', capability: 'Church Finder', category: 'Church Finder', gate: 'Read-only' },
  { id: 'skills', capability: 'Skills Registry', category: 'Skills Registry', gate: 'Proposal-only' },
  { id: 'actions', capability: 'Infrastructure Actions', category: 'Infrastructure Actions', gate: 'Human-gated' },
  { id: 'drafts', capability: 'Draft Work Items', category: 'Draft Work Items', gate: 'Human-gated' },
  { id: 'governance', capability: 'Governance', category: 'Governance', gate: 'Human-gated' },
  { id: 'diagnostics', capability: 'Diagnostics', category: 'Diagnostics', gate: 'Diagnostic' },
  { id: 'nagios', capability: 'Nagios monitoring ingest', category: 'Diagnostics', gate: 'Read-only' },
];

function buildCapabilityReadiness(byKey, healthVerdict, nowIso) {
  const state = (ok) => (ok ? 'available' : 'blocked');
  const statusJson = byKey.status.ok ? byKey.status.json : null;
  const nagios = statusJson?.nagios_monitoring;

  let nagiosState = 'pending';
  let nagiosReason = 'Nagios monitoring signal not present on /status';
  if (!byKey.status.ok) {
    nagiosState = 'unknown';
    nagiosReason = 'Runtime status probe failed — Nagios freshness unknown (not healthy)';
  } else if (!nagios || nagios.enabled === false) {
    nagiosState = 'partial';
    nagiosReason = 'Nagios adapter disabled — monitoring unavailable (not healthy)';
  } else if (
    nagios.freshness === 'fresh' &&
    nagios.adapter_state === 'ok' &&
    nagios.integration_health === 'ok'
  ) {
    nagiosState = 'available';
    nagiosReason = `Nagios ingest fresh — ${nagios.hosts_total ?? '?'} hosts, ${nagios.hosts_down ?? 0} down, ${nagios.services_critical ?? 0} critical`;
  } else {
    nagiosState = 'partial';
    nagiosReason = `Nagios freshness=${nagios.freshness || 'unknown'} state=${nagios.adapter_state || 'unknown'} (not treated as healthy)`;
  }

  const map = {
    ask: {
      state: !healthVerdict.brain_online ? 'blocked' : healthVerdict.llm_available ? 'available' : 'partial',
      reason: !healthVerdict.brain_online
        ? 'Brain upstream unreachable'
        : healthVerdict.llm_available
          ? 'Brain reachable and LLM circuit available'
          : 'Brain reachable but LLM circuit degraded — retrieval-only',
      last_verified: nowIso,
    },
    theology: {
      state: healthVerdict.brain_online ? 'partial' : 'blocked',
      reason: 'Not actively probed this cycle (gated behind BRAIN_THEOLOGY_ENABLED on om-dev)',
      last_verified: 'not probed this cycle',
    },
    calendar: {
      state: 'available',
      reason: 'Deterministic paschalion math — no live dependency',
      last_verified: nowIso,
    },
    churches: {
      state: 'partial',
      reason: 'Live vs. cache-only depends on GOOGLE_PLACES_API_KEY — config-missing until key is present (not probed as healthy)',
      last_verified: 'not probed this cycle',
    },
    skills: {
      state: state(byKey.skills.ok),
      reason: byKey.skills.ok ? `Skills registry responded (${healthVerdict.skills_registered ?? 0} registered)` : `GET /brain/skills failed: ${byKey.skills.error}`,
      last_verified: nowIso,
    },
    actions: {
      state: state(byKey.actions.ok),
      reason: byKey.actions.ok ? 'Actions registry responded' : `GET /brain/actions failed: ${byKey.actions.error}`,
      last_verified: nowIso,
    },
    drafts: {
      state: state(byKey.actions.ok),
      reason: 'Tracks the actions registry — draft creation is itself a human-gated action',
      last_verified: nowIso,
    },
    governance: {
      state: state(byKey.governance.ok),
      reason: byKey.governance.ok ? 'Governance health responded' : `GET /governance/health failed: ${byKey.governance.error}`,
      last_verified: nowIso,
    },
    diagnostics: {
      state: healthVerdict.brain_online ? 'available' : 'blocked',
      reason: healthVerdict.brain_online ? 'Brain reachable for bounded diagnostic probes' : 'Brain unreachable — diagnostics cannot reach upstream',
      last_verified: nowIso,
    },
    nagios: {
      state: nagiosState,
      reason: nagiosReason,
      last_verified: nagios?.last_ok_at || nowIso,
    },
  };

  return CAPABILITY_DEFS.map((def) => ({
    id: def.id,
    capability: def.capability,
    category: def.category,
    gate: def.gate,
    state: map[def.id]?.state ?? 'pending',
    reason: map[def.id]?.reason ?? 'No live signal available',
    last_verified: map[def.id]?.last_verified ?? 'unknown',
  }));
}

// ---------------------------------------------------------------------------
// Event clustering + classification
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = /heartbeat|ping|poll|keepalive|status_check/i;
const AUDIT_PATTERNS = /audit|snapshot|inventory_scan/i;
const CLUSTER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes — events sharing a key within this gap join one cluster
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — identical key+payload within this gap is a duplicate

function safeParsePayload(row) {
  if (!row.payload_json) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

function pickFirst(...values) {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

const HOST_EVENT_RE = /^host\.(unreachable|recovered)$/i;

/**
 * Target identity for one ledger row. Prefers the first-class columns written
 * by om-brain ingestion (target_ip/target_name/...), then falls back to the
 * payload envelope (event_payload.hostname / host_id from older producers).
 */
function eventIdentityFromRow(row) {
  const payload = safeParsePayload(row) || {};
  const ep =
    (payload.event_payload && typeof payload.event_payload === 'object' && payload.event_payload) ||
    (payload.data && typeof payload.data === 'object' && payload.data) ||
    {};
  return {
    target_name: pickFirst(row.target_name, ep.target_name, ep.host_id, payload.target_name),
    target_ip: pickFirst(row.target_ip, ep.target_ip, ep.ip),
    target_host: pickFirst(row.target_host, ep.target_host, ep.hostname),
    target_service: pickFirst(row.target_service, ep.target_service, ep.service),
    check_method: pickFirst(row.check_method, ep.check_method, ep.collector),
    checked_from: pickFirst(row.checked_from, ep.checked_from),
    check_endpoint: pickFirst(ep.check_endpoint, ep.endpoint, ep.url),
    target_port: pickFirst(ep.target_port, ep.port),
    identity_status: pickFirst(row.target_identity_status),
    last_failure_at: pickFirst(ep.last_failure_at),
    last_success_at: pickFirst(ep.last_success_at),
    source_component: pickFirst(payload.source_system, ep.source_system, row.source),
  };
}

function identityIsMalformed(row, identity) {
  if (!HOST_EVENT_RE.test(String(row.event_type || ''))) return false;
  if (identity.identity_status === 'malformed') return true;
  return !identity.target_ip && !identity.target_host && !identity.target_name;
}

function eventKey(row) {
  const service = row.source || 'unknown-service';
  const type = row.event_type || 'unknown-event';
  const severity = (row.severity || 'info').toLowerCase();
  const identity = eventIdentityFromRow(row);

  // Host reachability (and any target-bearing) events group by
  // event_type + target + source_component + check_method (+ port/endpoint),
  // so OMStudio-unreachable and OMWorkshop-unreachable are separate incidents
  // while repeats for the same host collapse into one.
  const target = pickFirst(identity.target_ip, identity.target_host, identity.target_name);
  if (HOST_EVENT_RE.test(type) || target) {
    const targetKey = identityIsMalformed(row, identity) ? 'malformed-telemetry' : target || 'unknown-target';
    const sourceComponent = identity.source_component || service;
    const method = identity.check_method || 'unknown-method';
    const sub = pickFirst(identity.target_port, identity.check_endpoint) || '';
    return `${service}::${type}::${severity}::target=${targetKey}::${sourceComponent}::${method}::${sub}`;
  }

  const correlation = row.correlation || 'no-correlation';
  return `${service}::${type}::${severity}::${correlation}`;
}

/** Classifies + clusters raw event rows. Returns { classifiedRows, clusters, suppressedNoise }. */
function clusterAndClassifyEvents(rows) {
  const seenKeyPayload = new Map(); // key+payloadHash -> last timestamp ms, for duplicate detection
  const classifiedRows = [];

  const sorted = [...rows].sort((a, b) => new Date(a.observed_at || 0) - new Date(b.observed_at || 0));

  for (const row of sorted) {
    const severity = (row.severity || 'info').toLowerCase();
    const type = String(row.event_type || '');
    const payload = safeParsePayload(row);
    const payloadHash = payload ? JSON.stringify(payload).slice(0, 200) : '';
    const dupKey = `${eventKey(row)}::${payloadHash}`;
    const ts = new Date(row.observed_at || Date.now()).getTime();

    let classification = 'signal';
    if (severity === 'critical' || severity === 'error') {
      classification = 'requires_attention';
    } else if (AUDIT_PATTERNS.test(type) || severity === 'debug') {
      classification = 'low_value_audit';
    } else if (NOISE_PATTERNS.test(type)) {
      classification = 'expected_noise';
    }

    if (classification !== 'requires_attention' && seenKeyPayload.has(dupKey)) {
      const lastTs = seenKeyPayload.get(dupKey);
      if (ts - lastTs <= DUPLICATE_WINDOW_MS) {
        classification = 'duplicate';
      }
    }
    seenKeyPayload.set(dupKey, ts);

    classifiedRows.push({ row, classification, key: eventKey(row), ts });
  }

  // Group by key, then split into time-windowed clusters.
  const byKey = new Map();
  for (const item of classifiedRows) {
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item);
  }

  const clusters = [];
  let clusterSeq = 0;
  for (const [key, items] of byKey.entries()) {
    items.sort((a, b) => a.ts - b.ts);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      clusterSeq += 1;
      clusters.push(buildClusterSummary(`cluster-${clusterSeq}`, key, current));
      current = [];
    };
    for (const item of items) {
      if (current.length && item.ts - current[current.length - 1].ts > CLUSTER_WINDOW_MS) {
        flush();
      }
      current.push(item);
    }
    flush();
  }

  clusters.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());

  const suppressedNoise = summarizeSuppressedNoise(classifiedRows);

  return { classifiedRows, clusters, suppressedNoise };
}

/**
 * Human title for a host reachability cluster, in strict priority order:
 *   1. `<target_service or target_name> / <target_ip> unreachable`
 *   2. `<target_host> / <target_ip> unreachable`
 *   3. `<target_ip> unreachable`
 *   4. `<endpoint/url> unreachable`
 *   5. `Unknown host unreachable — malformed telemetry`
 * The raw event_type is NEVER the title — it is exposed as `event_type`
 * ("Type") metadata on the cluster instead.
 */
function hostClusterTitle(type, identity, malformed) {
  const verb = /recovered/i.test(type) ? 'recovered' : 'unreachable';
  if (malformed) return `Unknown host ${verb} — malformed telemetry`;

  const label = pickFirst(identity.target_service, identity.target_name);
  if (label && identity.target_ip) return `${label} / ${identity.target_ip} ${verb}`;
  if (identity.target_host && identity.target_ip) return `${identity.target_host} / ${identity.target_ip} ${verb}`;
  if (identity.target_ip) return `${identity.target_ip} ${verb}`;
  if (label && identity.target_host) return `${label} / ${identity.target_host} ${verb}`;
  if (identity.target_host) return `${identity.target_host} ${verb}`;
  if (label) return `${label} ${verb}`;
  if (identity.check_endpoint) return `${identity.check_endpoint} ${verb}`;
  return `Unknown host ${verb} — malformed telemetry`;
}

function buildClusterSummary(id, key, items) {
  const [service, type, severity] = key.split('::');
  const first = items[0].row;
  const last = items[items.length - 1].row;
  const count = items.length;

  const isHostEvent = HOST_EVENT_RE.test(type);
  // Latest row wins for identity (registry data may improve over time).
  const identity = eventIdentityFromRow(last);
  const malformed = isHostEvent && identityIsMalformed(last, identity);
  const targetLabel = pickFirst(
    identity.target_service,
    identity.target_name,
    identity.target_host,
    identity.target_ip,
  );
  const dominantClassification = items.some((i) => i.classification === 'requires_attention')
    ? 'requires_attention'
    : items.every((i) => i.classification === 'duplicate' || i.classification === 'expected_noise' || i.classification === 'low_value_audit')
      ? items[0].classification
      : 'signal';

  let impact;
  let recommended_action;
  let confidence;

  if (malformed) {
    impact = `${count} host reachability event(s) whose target host/IP could not be determined (source: ${identity.source_component || service}). The producer is emitting incomplete telemetry.`;
    recommended_action = `Fix the producer (${identity.source_component || service}) to include target_ip/target_host, or add the host to the OMBrain registry (inventory/hosts.json). Raw payloads are preserved in the ledger.`;
    confidence = 'high';
  } else if (dominantClassification === 'requires_attention') {
    const subject = isHostEvent && targetLabel
      ? `${targetLabel}${identity.target_ip && targetLabel !== identity.target_ip ? ` (${identity.target_ip})` : ''}`
      : service;
    impact = count > 1
      ? `${count} ${severity}-severity events targeting ${subject} (${type}) between ${first.observed_at} and ${last.observed_at}.`
      : `A ${severity}-severity event targeting ${subject} (${type}).`;
    recommended_action = isHostEvent && targetLabel
      ? `Investigate ${subject} immediately — checked from ${identity.checked_from || 'unknown vantage'} via ${identity.check_method || 'unknown method'}; recurring ${severity} ${type} events.`
      : `Investigate ${service} immediately — recurring ${severity} events of type ${type}.`;
    confidence = count >= 3 ? 'high' : 'medium';
  } else if (dominantClassification === 'expected_noise') {
    impact = `Routine ${type} signal from ${service}, occurred ${count} time(s). No service impact expected.`;
    recommended_action = 'Monitor only — classified as expected noise.';
    confidence = 'high';
  } else if (dominantClassification === 'low_value_audit') {
    impact = `Low-value audit/log entries from ${service} (${type}), occurred ${count} time(s).`;
    recommended_action = 'No action required — informational audit trail.';
    confidence = 'high';
  } else if (dominantClassification === 'duplicate') {
    impact = `${count} duplicate emissions of the same event from ${service} (${type}).`;
    recommended_action = 'No action required — likely a retry or duplicate emitter; consider de-duplicating at source if frequent.';
    confidence = 'medium';
  } else {
    impact = count > 1
      ? `${count} occurrences of ${type} from ${service} between ${first.observed_at} and ${last.observed_at}.`
      : `A single ${type} event from ${service}.`;
    recommended_action = count > 2
      ? `Review ${service} — this event has repeated ${count} times; confirm whether it indicates a developing trend.`
      : 'No action required — isolated occurrence.';
    confidence = count >= 3 ? 'medium' : 'low';
  }

  const title = isHostEvent
    ? hostClusterTitle(type, identity, malformed)
    : targetLabel
      ? `${type} — ${targetLabel}`
      : `${type} — ${service}`;

  return {
    id,
    title,
    event_type: type,
    count,
    first_seen: first.observed_at,
    last_seen: last.observed_at,
    severity,
    impact,
    likely_cause: isHostEvent
      ? `Pattern key: target=${pickFirst(identity.target_ip, identity.target_host, identity.target_name) || 'unknown'}, source=${identity.source_component || service}, method=${identity.check_method || 'unknown'}, event_type=${type}`
      : `Pattern key: service=${service}, event_type=${type}, severity=${severity}`,
    recommended_action,
    confidence,
    classification_summary: dominantClassification,
    malformed_telemetry: malformed || undefined,
    target: {
      target_name: identity.target_name,
      target_ip: identity.target_ip,
      target_host: identity.target_host,
      target_service: identity.target_service,
      check_method: identity.check_method,
      checked_from: identity.checked_from,
      check_endpoint: identity.check_endpoint,
      target_port: identity.target_port,
      source_component: identity.source_component,
      last_failure_at: identity.last_failure_at || (isHostEvent && !/recovered/i.test(type) ? last.observed_at : null),
      last_success_at: identity.last_success_at || (isHostEvent && /recovered/i.test(type) ? last.observed_at : null),
    },
    evidence_ids: items.map((i) => i.row.id ?? i.row.observed_at),
  };
}

function summarizeSuppressedNoise(classifiedRows) {
  const groups = new Map();
  for (const item of classifiedRows) {
    if (item.classification === 'signal' || item.classification === 'requires_attention') continue;
    const groupKey = `${item.classification}::${item.key}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { pattern: item.key, classification: item.classification, count: 0 });
    }
    groups.get(groupKey).count += 1;
  }
  return Array.from(groups.values()).map((g) => ({
    pattern: g.pattern,
    classification: g.classification,
    count: g.count,
    reason:
      g.classification === 'duplicate'
        ? 'Repeated identical event within a short window'
        : g.classification === 'expected_noise'
          ? 'Matches a known noisy/heartbeat-style event pattern'
          : 'Low-value audit/log-style entry',
  }));
}

// ---------------------------------------------------------------------------

const EVIDENCE_LINKS = [
  { label: 'Brain health', endpoint: '/api/brain/health' },
  { label: 'Runtime status', endpoint: '/api/brain/status' },
  { label: 'Governance health', endpoint: '/api/brain/governance/health' },
  { label: 'Skills registry', endpoint: '/api/brain/brain/skills' },
  { label: 'Actions registry', endpoint: '/api/brain/brain/actions' },
  { label: 'Decision ledger', endpoint: '/api/brain/decisions?limit=20' },
  { label: 'Event ledger', endpoint: '/api/brain/events' },
];

function buildExecutiveSummary(healthVerdict, operatorActions, recentChanges, sourcesOkCount, sourcesTotal) {
  const headline =
    healthVerdict.verdict === 'nominal'
      ? 'OMBrain is online and operating normally.'
      : healthVerdict.verdict === 'degraded'
        ? `OMBrain is online but degraded: ${healthVerdict.reason.replace('Brain is reachable, but ', '')}`
        : healthVerdict.verdict === 'offline'
          ? 'OMBrain is unreachable.'
          : 'OMBrain status could not be determined.';

  const explanation = `Brain reachability: ${healthVerdict.brain_online ? 'reachable' : 'unreachable'}. LLM circuit: ${healthVerdict._llm_status}. Governance mode: ${healthVerdict.governance_mode}. Skills registered: ${healthVerdict.skills_registered ?? 'unknown'}.`;

  const changeNote = recentChanges.find((c) => c.id !== 'change-baseline' && c.id !== 'change-none' && !c.id.startsWith('change-activity'));
  const changed_since_last_check = changeNote
    ? changeNote.summary
    : recentChanges[0]?.summary ?? 'No prior snapshot to compare yet.';

  const operator_attention_required = operatorActions.some((a) => a.severity !== 'info');

  const ratio = sourcesTotal ? sourcesOkCount / sourcesTotal : 0;
  const confidence = ratio === 1 ? 'high' : ratio >= 0.5 ? 'medium' : 'low';

  return { headline, explanation, changed_since_last_check, operator_attention_required, confidence };
}

async function buildBriefing() {
  const nowIso = new Date().toISOString();
  const byKey = await fetchAllSources();
  const raw_source_status = buildRawSourceStatus(byKey, nowIso);
  const sourcesOkCount = raw_source_status.filter((s) => s.ok).length;

  const healthVerdict = buildHealthVerdict(byKey);

  const eventRows = byKey.events.ok && Array.isArray(byKey.events.json?.findings) ? byKey.events.json.findings : [];
  const { clusters, suppressedNoise } = clusterAndClassifyEvents(eventRows);

  const operatorActions = buildOperatorActions(byKey, healthVerdict, clusters);
  const activeIncidents = trackIncidents(operatorActions, nowIso);

  const currentSnapshot = {
    brain_online: healthVerdict.brain_online,
    llm_status: healthVerdict._llm_status,
    governance_mode: healthVerdict.governance_mode,
    skills_registered: healthVerdict.skills_registered,
  };
  const recentChanges = buildRecentChanges(currentSnapshot, nowIso);
  previousSnapshot = currentSnapshot;

  const capabilityReadiness = buildCapabilityReadiness(byKey, healthVerdict, nowIso);

  const executiveSummary = buildExecutiveSummary(
    healthVerdict,
    operatorActions,
    recentChanges,
    sourcesOkCount,
    raw_source_status.length,
  );

  const { _llm_status, ...healthVerdictPublic } = healthVerdict;
  void _llm_status;

  return {
    generated_at: nowIso,
    overall_state: healthVerdict.verdict,
    executive_summary: executiveSummary,
    health_verdict: healthVerdictPublic,
    operator_actions: operatorActions,
    active_incidents: activeIncidents,
    recent_changes: recentChanges,
    capability_readiness: capabilityReadiness,
    event_clusters: clusters,
    suppressed_noise: suppressedNoise,
    evidence_links: EVIDENCE_LINKS,
    raw_source_status,
  };
}

// clusterAndClassifyEvents exported for tests/diagnostics; buildBriefing is the API.
module.exports = { buildBriefing, clusterAndClassifyEvents };
