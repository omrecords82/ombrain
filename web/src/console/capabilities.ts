import type {
  BlockerItem,
  CapabilityDetail,
  CapabilityGate,
  SafetyLevel,
  VerifiedCapabilityGroup,
} from './types';

/** Raw capability documentation, preserved for the Governance screen's free-text filter. */
export const CAPABILITIES = {
  working: [
    'Unified ask — POST /brain/ask (auto-routes calendar, study, ops, pastoral, …)',
    'Orthodox calendar — Pascha, feasts, fasting, saints, today (deterministic, no LLM)',
    'Theology RAG — keyword search + /theology/ask (when BRAIN_THEOLOGY_ENABLED on om-dev)',
    'Incident diagnose — POST /diagnose',
    'Decision ledger — GET /decisions',
    'Knowledge, procedures, tasks memory APIs',
    'Operations API — GET/POST /brain/operations (doc-registry-scan, host/schema snapshots, workshop.status@v1, fleet.find_env_files@v1)',
    'Fleet ops — NATS broker on om-dev (.254:4222); fleet.find_env_files@v1 verified live',
    'Executable skills — GET/POST /brain/skills (register bash/python/node scripts)',
    'Governance / OMStudio webhook integration (dry-run outbox by default)',
    'Local console — om-brain-console on om-dev (.254:8392) → 127.0.0.1:8390',
    'Event / inventory adapters — BRAIN_OPS_JWT provisioned (brain_ingest); re-run provision-brain-ingest.sh after JWT_ACCESS_SECRET rotation',
    'OMAI actions bridge — GET/POST /brain/actions (4 live: system status, health probes, draft work-item create)',
    'Draft work items — omai.work_item.create_draft@v1 creates om_daily_items at status draft (no start-work)',
    'Teaching agent — POST /brain/teach/skill-proposal (compile skill proposals; dry-run default, governance for activation)',
  ],
  blocked: [
    'Google Places live search — GOOGLE_PLACES_API_KEY not set on OMAI (.239); cache-only until configured',
    'Log adapter — BRAIN_ENABLE_LOG_ADAPTER=false until :7060→:3001 WS bridge is stable',
    'Plane draft mirror — plane.issue.create_draft@v1 needs PLANE_API_TOKEN on OMAI (.239); OMAI-only draft create works',
    'NATS remote satellites — broker + fleet ops live on om-dev (.254:4222); per-host satellite workers not deployed fleet-wide',
    'Public Brain URL — brain binds loopback; LAN via nginx om-brain-lan-api (.254:8390) and om-brain-console (.254:8392)',
  ],
};

const GATE_BY_SAFETY: Record<SafetyLevel, CapabilityGate> = {
  'read-only': 'Read-only',
  diagnostic: 'Diagnostic',
  'proposal-only': 'Proposal-only',
  'human-gated': 'Human-gated',
  blocked: 'Human-gated',
};

export function gateForSafety(safety: SafetyLevel): CapabilityGate {
  return GATE_BY_SAFETY[safety];
}

/**
 * Categorized capability matrix. `lastVerified` is intentionally qualitative for
 * deterministic/local capabilities (no live dependency to probe) and is overridden
 * with the real health-check timestamp at render time for capabilities that depend
 * on the live om-brain connection — see `withLiveVerification` in CapabilityMatrix.
 */
export const capabilityMatrix: CapabilityDetail[] = [
  {
    id: 'ask',
    capability: 'Unified Ask',
    category: 'Ask / Knowledge',
    state: 'available',
    safety: 'read-only',
    gate: gateForSafety('read-only'),
    note: 'Knowledge & technical Q&A, auto-routes to calendar/study/ops/pastoral',
    lastVerified: 'Live — verified on health probe',
    endpoint: 'POST /brain/ask',
    navigateTo: 'ask',
    detailBullets: [
      'Auto-routes between calendar, study, ops, and pastoral handlers',
      'Force a mode with force_mode in the request body',
      'Never executes infrastructure actions directly',
    ],
  },
  {
    id: 'theology',
    capability: 'Theology / Knowledge RAG',
    category: 'Ask / Knowledge',
    state: 'partial',
    safety: 'proposal-only',
    gate: gateForSafety('proposal-only'),
    note: 'Source-grounded answers; returns 503 when BRAIN_THEOLOGY_ENABLED is off',
    lastVerified: 'Depends on om-dev flag — verify before relying on it',
    endpoint: 'POST /brain/theology/ask',
    navigateTo: 'theology',
    detailBullets: [
      'Keyword search + retrieval-augmented answers with mandatory citations',
      'Disabled returns 503 theology_disabled, not an outage',
      'Never issues doctrinal or canonical rulings',
    ],
  },
  {
    id: 'calendar',
    capability: 'Calendar & Saints',
    category: 'Orthodox Calendar & Saints',
    state: 'available',
    safety: 'read-only',
    gate: gateForSafety('read-only'),
    note: 'Pascha, old calendar, commemorations — deterministic, no LLM dependency',
    lastVerified: 'Deterministic logic — re-verified on every call',
    endpoint: 'GET /brain/calendar/*',
    navigateTo: 'calendar',
    detailBullets: ['Paschalion math is local and has no external dependency', 'Safe to run at any time'],
  },
  {
    id: 'fasting',
    capability: 'Fasting Calendar',
    category: 'Orthodox Calendar & Saints',
    state: 'pending',
    safety: 'read-only',
    gate: gateForSafety('read-only'),
    note: 'Fasting rules engine pending expansion',
    lastVerified: 'Not yet implemented',
    navigateTo: 'calendar',
    detailBullets: ['Surfaced as pending in the UI until the rules engine ships'],
  },
  {
    id: 'churches',
    capability: 'Church Finder',
    category: 'Church Finder',
    state: 'partial',
    safety: 'read-only',
    gate: gateForSafety('read-only'),
    note: 'Live Google Places when configured, otherwise church_memory cache only',
    lastVerified: 'Depends on GOOGLE_PLACES_API_KEY on OMAI',
    endpoint: 'POST /brain/churches/find',
    navigateTo: 'churches',
    detailBullets: [
      'Falls back to cached parish directory when Places key is absent',
      'Set GOOGLE_PLACES_API_KEY in OMStudio Platform Secrets to enable live search',
    ],
  },
  {
    id: 'skills',
    capability: 'Skills Registry',
    category: 'Skills Registry',
    state: 'available',
    safety: 'proposal-only',
    gate: gateForSafety('proposal-only'),
    note: 'Governed catalog of executable bash/python/node skills',
    lastVerified: 'Live — verified on health probe (GET /brain/skills)',
    endpoint: 'GET/POST /brain/skills',
    navigateTo: 'skills',
    detailBullets: [
      'New skills are registered, not executed, until explicitly run',
      'Unsafe patterns (e.g. rm -rf) are rejected by om-brain at registration',
    ],
  },
  {
    id: 'teaching',
    capability: 'Teach Skill',
    category: 'Skills Registry',
    state: 'available',
    safety: 'proposal-only',
    gate: gateForSafety('proposal-only'),
    note: 'Teaching agent compiles skill/procedure proposals — no execution',
    lastVerified: 'Live — dry-run validated against manifest + RuleEngine',
    endpoint: 'POST /brain/teach/skill-proposal',
    navigateTo: 'teach',
    detailBullets: ['Dry-run validates the manifest before any proposal is stored', 'Submitted proposals route medium/high risk to OMStudio governance'],
  },
  {
    id: 'actions',
    capability: 'Infrastructure Actions',
    category: 'Infrastructure Actions',
    state: 'partial',
    safety: 'human-gated',
    gate: gateForSafety('human-gated'),
    note: 'Read-only actions run immediately; mutations require dry-run then commit',
    lastVerified: 'Live — verified via GET /brain/actions',
    endpoint: 'GET/POST /brain/actions',
    navigateTo: 'actions',
    detailBullets: [
      '4 live actions today: system status, health probes, draft work-item create',
      'Mutating actions always preview as a dry-run before commit is allowed',
    ],
  },
  {
    id: 'drafts',
    capability: 'Draft Work Items',
    category: 'Draft Work Items',
    state: 'available',
    safety: 'human-gated',
    gate: gateForSafety('human-gated'),
    note: 'omai.work_item.create_draft@v1 — draft-only intake, no start-work',
    lastVerified: 'Live — creates om_daily_items at status draft',
    endpoint: 'POST /brain/actions/omai.work_item.create_draft@v1/run',
    navigateTo: 'actions',
    detailBullets: ['Creates a draft only — never starts work automatically', 'Plane mirror is blocked until PLANE_API_TOKEN is set on OMAI'],
  },
  {
    id: 'diagnostics',
    capability: 'Diagnostics',
    category: 'Diagnostics',
    state: 'available',
    safety: 'diagnostic',
    gate: gateForSafety('diagnostic'),
    note: 'Operator service checks & POST /diagnose (use_model: false)',
    lastVerified: 'Live — bounded read-only probes',
    endpoint: 'POST /diagnose',
    navigateTo: 'diagnostics',
    detailBullets: ['Structured incident analysis without invoking the LLM', 'Never mutates state'],
  },
  {
    id: 'governance',
    capability: 'Governance',
    category: 'Governance',
    state: 'available',
    safety: 'human-gated',
    gate: gateForSafety('human-gated'),
    note: 'Review & approval queue; medium/high-risk actions hand off to OMStudio',
    lastVerified: 'Live — verified via GET /governance/health',
    endpoint: 'GET /governance/health',
    navigateTo: 'governance',
    detailBullets: ['Auditor posture by default — OMBrain does not execute unsafe actions directly'],
  },
  {
    id: 'decisions',
    capability: 'Decision Ledger',
    category: 'Governance',
    state: 'available',
    safety: 'read-only',
    gate: gateForSafety('read-only'),
    note: 'Append-only orchestrator decisions from decision_memory',
    lastVerified: 'Live — GET /decisions',
    endpoint: 'GET /decisions',
    navigateTo: 'decisions',
  },
];

/**
 * Verified-today capability groups — structured replacement for the raw bullet list.
 * Derived from the same factual inventory as CAPABILITIES.working, grouped for scanability.
 */
export const VERIFIED_CAPABILITIES: VerifiedCapabilityGroup[] = [
  {
    group: 'Runtime',
    items: [
      { id: 'rt-console', title: 'Local console proxy reachable', source: 'om-brain-console (.254:8392) → 127.0.0.1:8390', lastVerified: 'On every refresh' },
      { id: 'rt-health', title: 'om-brain health probe', source: 'GET /health, GET /governance/health', lastVerified: 'On every refresh' },
    ],
  },
  {
    group: 'Knowledge',
    items: [
      { id: 'kn-ask', title: 'Unified ask routing', source: 'POST /brain/ask', lastVerified: 'Verified live' },
      { id: 'kn-calendar', title: 'Pascha, feasts, fasting, saints, today', source: 'GET /brain/calendar/*', lastVerified: 'Deterministic — always current' },
      { id: 'kn-theology', title: 'Theology RAG (keyword + grounded ask)', source: '/brain/theology/ask', lastVerified: 'When BRAIN_THEOLOGY_ENABLED' },
    ],
  },
  {
    group: 'Governance',
    items: [
      { id: 'gv-webhook', title: 'OMStudio webhook integration', source: 'Dry-run outbox by default', lastVerified: 'Verified configuration' },
      { id: 'gv-decisions', title: 'Decision ledger inspection', source: 'GET /decisions', lastVerified: 'Verified live' },
      { id: 'gv-diagnose', title: 'Incident diagnose', source: 'POST /diagnose', lastVerified: 'Verified live' },
    ],
  },
  {
    group: 'Actions',
    items: [
      { id: 'ac-bridge', title: 'OMAI actions bridge (4 live actions)', source: 'GET/POST /brain/actions', lastVerified: 'Verified live' },
      { id: 'ac-skills', title: 'Executable skills registry', source: 'GET/POST /brain/skills', lastVerified: 'Verified live' },
      { id: 'ac-teach', title: 'Teaching agent skill proposals', source: 'POST /brain/teach/skill-proposal', lastVerified: 'Dry-run validated' },
    ],
  },
  {
    group: 'Fleet / Infrastructure',
    items: [
      { id: 'fl-nats', title: 'Fleet ops via NATS broker', source: 'om-dev .254:4222 — fleet.find_env_files@v1', lastVerified: 'Verified live' },
      { id: 'fl-ops', title: 'Operations API snapshots', source: 'GET/POST /brain/operations', lastVerified: 'Verified live' },
    ],
  },
  {
    group: 'Work Items',
    items: [
      { id: 'wi-draft', title: 'Draft work-item create', source: 'omai.work_item.create_draft@v1 → om_daily_items', lastVerified: 'Verified live (draft-only)' },
    ],
  },
  {
    group: 'Docs / Memory',
    items: [
      { id: 'dm-memory', title: 'Knowledge, procedures & tasks memory APIs', source: 'om-brain memory subsystem', lastVerified: 'Verified live' },
      { id: 'dm-events', title: 'Event / inventory adapters', source: 'BRAIN_OPS_JWT (brain_ingest)', lastVerified: 'Provisioned' },
    ],
  },
];

/** Structured warnings / blockers — replaces the raw "blocked or not built" dump. */
export const BLOCKERS: BlockerItem[] = [
  {
    id: 'bl-places',
    category: 'config-missing',
    name: 'Google Places live search',
    impact: 'Church Finder serves cache-only results instead of live search',
    requiredFix: 'Set GOOGLE_PLACES_API_KEY in OMStudio Platform Secrets on OMAI (.239)',
    owner: 'OMAI / OMStudio secrets',
    severity: 'warning',
  },
  {
    id: 'bl-log-adapter',
    category: 'not-built',
    name: 'Log adapter',
    impact: 'No automated log ingestion from the :7060→:3001 WS bridge',
    requiredFix: 'Stabilize the WS bridge, then set BRAIN_ENABLE_LOG_ADAPTER=true',
    owner: 'om-brain platform',
    severity: 'info',
  },
  {
    id: 'bl-plane',
    category: 'config-missing',
    name: 'Plane draft mirror',
    impact: 'plane.issue.create_draft@v1 cannot mirror drafts into Plane',
    requiredFix: 'Set PLANE_API_TOKEN on OMAI (.239) — OMAI-only draft create still works',
    owner: 'OMAI integration',
    severity: 'warning',
  },
  {
    id: 'bl-satellites',
    category: 'not-built',
    name: 'NATS remote satellites',
    impact: 'Fleet ops run from om-dev only; per-host satellite workers are not deployed fleet-wide',
    requiredFix: 'Deploy satellite workers to remaining fleet hosts',
    owner: 'Fleet ops',
    severity: 'info',
  },
  {
    id: 'bl-public-url',
    category: 'blocked',
    name: 'Public Brain URL',
    impact: 'om-brain only answers on loopback; no direct internet exposure by design',
    requiredFix: 'Not required — by design. LAN access via nginx (.254:8390 / :8392)',
    owner: 'Security boundary',
    severity: 'info',
  },
];

export const ASK_EXAMPLES = [
  'when is pascha 2027',
  'what saints are commemorated today on the old calendar?',
  'summarize orthodox-backend health checks',
  'what is theosis?',
];
