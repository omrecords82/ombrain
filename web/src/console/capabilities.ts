import type { CapabilityMatrixItem } from './types';

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

export const capabilityMatrix: CapabilityMatrixItem[] = [
  { id: 'health', capability: 'Health', state: 'available', safety: 'read-only', note: 'Service heartbeat & version' },
  { id: 'ask', capability: 'Ask Brain', state: 'available', safety: 'read-only', note: 'Knowledge & technical Q&A' },
  { id: 'calendar', capability: 'Calendar & Saints', state: 'available', safety: 'read-only', note: 'Pascha, old calendar, commemorations' },
  { id: 'theology', capability: 'Theology / Knowledge', state: 'partial', safety: 'read-only', note: 'Source-grounded answers (503 if disabled)' },
  { id: 'churches', capability: 'Church Finder', state: 'partial', safety: 'read-only', note: 'Live or cache-only depending on Places key' },
  { id: 'diagnostics', capability: 'Diagnostics', state: 'available', safety: 'diagnostic', note: 'Operator service checks & /diagnose' },
  { id: 'decisions', capability: 'Decisions', state: 'available', safety: 'read-only', note: 'Decision log inspection' },
  { id: 'skills', capability: 'Skills Registry', state: 'available', safety: 'proposal-only', note: 'Governed capability catalog' },
  { id: 'governance', capability: 'Governance', state: 'available', safety: 'human-gated', note: 'Review & approval queue' },
  { id: 'fasting', capability: 'Fasting Calendar', state: 'pending', safety: 'read-only', note: 'Pending engine expansion' },
  { id: 'actions', capability: 'Infrastructure Actions', state: 'partial', safety: 'human-gated', note: 'Read-only actions live; writes need dry-run + commit' },
  { id: 'drafts', capability: 'Draft Work Items', state: 'available', safety: 'human-gated', note: 'omai.work_item.create_draft@v1 — draft-only intake' },
  { id: 'teaching', capability: 'Teach Skill', state: 'available', safety: 'proposal-only', note: 'POST /brain/teach/skill-proposal — no execution' },
];

export const ASK_EXAMPLES = [
  'when is pascha 2027',
  'what saints are commemorated today on the old calendar?',
  'summarize orthodox-backend health checks',
  'what is theosis?',
];
