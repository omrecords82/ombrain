/**
 * OM Brain client — calls /api/brain/* on the local om-brain-console proxy (om-dev .254).
 *
 * Path rule mirrors OMAI: root routes /health, /diagnose; brain sub-routes /brain/ask, etc.
 */

const ROOT = '/api/brain';
const BRAIN = '/api/brain/brain';

class BrainApiError extends Error {
  status?: number;
  raw?: unknown;

  constructor(message: string, status?: number, raw?: unknown) {
    super(message);
    this.name = 'BrainApiError';
    this.status = status;
    this.raw = raw;
  }
}

async function request<T>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data != null ? JSON.stringify(data) : undefined,
    credentials: 'same-origin',
  });

  const text = await res.text();
  let payload: unknown = text;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const msg =
      typeof payload === 'object' && payload && 'detail' in payload
        ? String((payload as { detail?: unknown }).detail)
        : typeof payload === 'object' && payload && 'error' in payload
          ? String((payload as { error?: unknown }).error)
          : text || `HTTP ${res.status}`;
    throw new BrainApiError(msg, res.status, payload);
  }

  return payload as T;
}

function get<T>(url: string): Promise<T> {
  return request<T>('GET', url);
}

function post<T>(url: string, data?: unknown): Promise<T> {
  return request<T>('POST', url, data);
}

export interface ProxyHealth {
  ok: boolean;
  service: string;
  brain_endpoint?: string;
  fleet_environment?: string;
  google_places_configured?: boolean | null;
  host?: string;
  note?: string;
}

export type LlmCircuitStatus =
  | 'available'
  | 'disabled'
  | 'not_configured'
  | 'degraded'
  | 'error';

export interface BrainLlmStatus {
  status: LlmCircuitStatus;
  provider?: string;
  model?: string | null;
  api_key_present?: boolean;
  memory_backend?: string;
  last_probe?: string | null;
  last_error?: string | null;
}

export interface BrainHealth {
  ok?: boolean;
  service?: string;
  memory_backend?: string;
  llm?: BrainLlmStatus;
  llm_endpoint_allowed?: boolean;
  llm_endpoint_reason?: string;
  executes_actions?: boolean;
  transport?: string;
  webhook_secret_configured?: boolean;
  [key: string]: unknown;
}

export interface BrainRuntimeStatus {
  ok?: boolean;
  service?: string;
  state?: string;
  version?: string | null;
  uptime_sec?: number;
  hostname?: string;
  memory_backend?: string;
  executes_actions?: boolean;
  llm?: {
    status?: string;
    endpoint_allowed?: boolean;
    endpoint_reason?: string;
  };
  nats?: {
    configured?: boolean;
    url_host?: string | null;
    state?: string;
    transport?: string;
  };
  ops_auth?: {
    valid?: boolean;
    health?: string;
    needs_attention?: boolean;
  };
}

export interface BrainActivityRecord {
  request_id: string;
  timestamp: string;
  user_id: number | null;
  user_role: string | null;
  endpoint: string;
  method: string;
  capability: string;
  governance: string;
  latency_ms: number;
  outcome: 'success' | 'error' | 'warning';
  label: string;
  error_summary: string | null;
}

export interface BrainActivityList {
  ok?: boolean;
  count: number;
  activity: BrainActivityRecord[];
  source?: string;
  unavailable?: boolean;
  message?: string;
}

export interface BrainEventRecord {
  id?: number;
  source?: string;
  event_type?: string;
  severity?: string | null;
  church_id?: number | null;
  correlation?: string | null;
  payload_json?: string;
  observed_at?: string;
}

export interface BrainEventList {
  ok?: boolean;
  count: number;
  findings: BrainEventRecord[];
}

export type AskMode = 'auto' | 'knowledge' | 'technical' | 'ops';

const MODE_MAP: Record<Exclude<AskMode, 'auto'>, string> = {
  knowledge: 'study',
  technical: 'ops',
  ops: 'ops',
};

export function resolveForceMode(mode: AskMode): string | undefined {
  if (mode === 'auto') return undefined;
  return MODE_MAP[mode];
}

export async function getProxyHealth(): Promise<ProxyHealth> {
  return get<ProxyHealth>(`${ROOT}/proxy-health`);
}

function isBrainHealthPayload(data: unknown): data is BrainHealth {
  return (
    data != null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    ('ok' in data || 'service' in data || 'llm' in data || 'executes_actions' in data)
  );
}

export function assertBrainJsonResponse<T>(data: unknown, label: string): T {
  if (typeof data === 'string') {
    throw new BrainApiError(summarizeHtmlError(data));
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new BrainApiError(`${label} returned non-JSON response`);
  }
  return data as T;
}

export function deriveFleetEnvironment(brainEndpoint?: string): string {
  if (!brainEndpoint) return 'om-dev-254';
  try {
    const base = brainEndpoint.startsWith('http') ? brainEndpoint : `http://${brainEndpoint}`;
    const last = new URL(base).hostname.split('.').pop();
    if (last && /^\d+$/.test(last)) return `om-dev-${last}`;
  } catch {
    /* ignore */
  }
  return 'om-dev-254';
}

export type BrainProbeErrorKind = 'maintenance' | 'auth' | 'upstream' | 'proxy' | 'unknown';

export function classifyBrainProbeError(err: unknown): BrainProbeErrorKind {
  const msg = formatBrainApiError(err).toLowerCase();
  if (
    (msg.includes('updating') && msg.includes('orthodox'))
    || msg.includes('system update in progress')
    || msg.includes('scheduled maintenance')
    || msg.includes('receiving updates')
  ) {
    return 'maintenance';
  }
  if (
    msg.includes('authentication required')
    || msg.includes('insufficient permissions')
    || msg.includes('401')
    || msg.includes('403')
  ) return 'auth';
  if (msg.includes('brain proxy offline') || msg.includes('proxy')) return 'proxy';
  if (msg.includes('unreachable') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return 'upstream';
  }
  return 'unknown';
}

export function formatBrainReachabilityError(err: unknown): string {
  const detail = formatBrainApiError(err);
  switch (classifyBrainProbeError(err)) {
    case 'maintenance':
      return `OM maintenance page (not om-brain): ${detail}`;
    case 'auth':
      return `Console auth required: ${detail}`;
    case 'proxy':
      return detail;
    default:
      return `Console OK but om-brain unreachable: ${detail}`;
  }
}

export function activityShowsUpstreamReachable(activity: BrainActivityRecord[]): boolean {
  return activity.some((row) => {
    if (row.outcome !== 'success') return false;
    const ep = row.endpoint.toLowerCase();
    return (
      ep === '/health'
      || ep === '/governance/health'
      || ep === '/brain/skills'
      || ep.endsWith('/skills')
    );
  });
}

export async function getBrainHealth(): Promise<BrainHealth> {
  const data = assertBrainJsonResponse<BrainHealth>(await brainRootGet<BrainHealth>('/health'), '/health');
  if (!isBrainHealthPayload(data)) {
    throw new BrainApiError('/health returned unexpected payload');
  }
  return data;
}

export async function getBrainRuntimeStatus(): Promise<BrainRuntimeStatus> {
  return assertBrainJsonResponse<BrainRuntimeStatus>(
    await brainRootGet<BrainRuntimeStatus>('/status'),
    '/status',
  );
}

export function formatBrainUptime(uptimeSec?: number): string | undefined {
  if (uptimeSec == null || uptimeSec < 0) return undefined;
  if (uptimeSec < 60) return `${uptimeSec}s`;
  if (uptimeSec < 3600) return `${Math.floor(uptimeSec / 60)}m`;
  if (uptimeSec < 86400) {
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export async function listBrainActivity(limit = 50): Promise<BrainActivityList> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return get<BrainActivityList>(`${ROOT}/activity${qs}`);
}

/** Optional OMAI proxy activity — best effort, never required for console health. */
export async function listOmaiProxyActivity(limit = 50): Promise<BrainActivityList> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return get<BrainActivityList>(`${ROOT}/omai-activity${qs}`);
}

export async function listBrainEvents(limit = 50): Promise<BrainEventList> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return brainRootGet<BrainEventList>(`/events${qs}`);
}

export function brainRootGet<T = unknown>(path: string): Promise<T> {
  return get<T>(`${ROOT}${path.startsWith('/') ? path : `/${path}`}`);
}

export function brainRootPost<T = unknown>(path: string, data?: unknown): Promise<T> {
  return post<T>(`${ROOT}${path.startsWith('/') ? path : `/${path}`}`, data);
}

export function brainGet<T = unknown>(path: string): Promise<T> {
  return get<T>(`${BRAIN}${path.startsWith('/') ? path : `/${path}`}`);
}

export function brainPost<T = unknown>(path: string, data?: unknown): Promise<T> {
  return post<T>(`${BRAIN}${path.startsWith('/') ? path : `/${path}`}`, data);
}

export async function askBrain(query: string, mode: AskMode, sessionId?: string): Promise<unknown> {
  const force_mode = resolveForceMode(mode);
  const body: Record<string, unknown> = { query };
  if (force_mode) body.force_mode = force_mode;
  if (sessionId?.trim()) body.session_id = sessionId.trim();
  return brainPost('/ask', body);
}

export async function askTheology(question: string): Promise<unknown> {
  return brainPost('/theology/ask', { question });
}

export interface ChurchFinderResult {
  ok?: boolean;
  query?: string;
  geocoded_address?: string;
  churches?: Array<Record<string, unknown>>;
  total?: number;
  source?: string;
  degraded?: boolean;
  mode?: 'cache_only' | string;
  note?: string;
  error?: string;
}

export async function findChurches(query: string, radiusMiles = 25): Promise<ChurchFinderResult> {
  return brainPost('/churches/find', { query, radius_miles: radiusMiles });
}

export type SkillLanguage = 'bash' | 'python' | 'node';

export interface BrainSkill {
  skill_key: string;
  title?: string;
  description?: string | null;
  language: SkillLanguage | string;
  script_body?: string;
  tags?: string[] | null;
  version?: number;
  run_count?: number;
  active?: number;
  source?: string;
}

export interface SkillsListResult {
  count: number;
  skills: BrainSkill[];
}

export interface CreateSkillPayload {
  key: string;
  language: SkillLanguage;
  script: string;
  title?: string;
  description?: string;
  tags?: string[];
}

export interface CreateSkillResult {
  ok: boolean;
  skill_key: string;
  version?: number;
  warnings?: string[];
}

export async function listSkills(all = false): Promise<SkillsListResult> {
  const qs = all ? '?all=true' : '';
  return brainGet<SkillsListResult>(`/skills${qs}`);
}

export async function getSkill(key: string): Promise<{ skill: BrainSkill }> {
  return brainGet<{ skill: BrainSkill }>(`/skills/${encodeURIComponent(key)}`);
}

export async function createSkill(payload: CreateSkillPayload): Promise<CreateSkillResult> {
  return brainPost<CreateSkillResult>('/skills', payload);
}

export async function runSkill(
  key: string,
  options?: { execute?: boolean; args?: string[] },
): Promise<unknown> {
  return brainPost(`/skills/${encodeURIComponent(key)}/run`, {
    execute: options?.execute ?? false,
    args: options?.args,
  });
}

export interface BrainAction {
  id: string;
  source: string;
  category: string;
  title: string;
  description: string;
  risk: string;
  mutation: boolean;
  supports_dry_run: boolean;
}

export interface BrainActionsList {
  ok?: boolean;
  count: number;
  actions: BrainAction[];
}

export async function listBrainActions(params?: {
  source?: string;
  category?: string;
  risk?: string;
}): Promise<BrainActionsList> {
  const qs = new URLSearchParams();
  if (params?.source) qs.set('source', params.source);
  if (params?.category) qs.set('category', params.category);
  if (params?.risk) qs.set('risk', params.risk);
  const q = qs.toString();
  return brainGet<BrainActionsList>(`/actions${q ? `?${q}` : ''}`);
}

export async function runBrainAction(
  id: string,
  payload: { input?: unknown; dry_run?: boolean; commit?: boolean; confirm?: boolean },
): Promise<unknown> {
  return brainPost(`/actions/${encodeURIComponent(id)}/run`, payload);
}

export interface TeachingProposalInput {
  source: string;
  goal: string;
  evidence?: string;
  proposed_scope?: string;
  risk_hint?: string;
}

export async function submitTeachingProposal(
  input: TeachingProposalInput,
  opts: { dryRun?: boolean; submit?: boolean },
): Promise<unknown> {
  const body: Record<string, unknown> = { input };
  if (opts.dryRun) body.dry_run = true;
  if (opts.submit) body.submit = true;
  return brainPost('/teach/skill-proposal', body);
}

function summarizeHtmlError(text: string, status?: number): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<!DOCTYPE') && !trimmed.startsWith('<html') && !trimmed.startsWith('<')) {
    return trimmed;
  }
  const preMatch = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const preText = preMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
  const titleText = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
  const detail = preText || titleText || 'Internal Server Error';
  const code = status && status > 0 ? status : 500;
  return `${detail} (HTTP ${code})`;
}

export function formatBrainApiError(err: unknown): string {
  if (typeof err === 'string') {
    return summarizeHtmlError(err);
  }
  if (err instanceof Error) {
    return summarizeHtmlError(err.message);
  }
  if (err && typeof err === 'object') {
    const apiErr = err as {
      message?: unknown;
      error?: unknown;
      detail?: unknown;
      status?: unknown;
    };
    const parts: string[] = [];
    const status = typeof apiErr.status === 'number' ? apiErr.status : undefined;
    if (typeof apiErr.message === 'string' && apiErr.message) {
      parts.push(summarizeHtmlError(apiErr.message, status));
    }
    if (typeof apiErr.detail === 'string' && apiErr.detail) parts.push(apiErr.detail);
    if (typeof apiErr.error === 'string' && apiErr.error) parts.push(apiErr.error);
    if (parts.length) return parts.filter(Boolean).join(' — ');
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  }
  return String(err);
}

export function parseSkillsCount(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const row = payload as Record<string, unknown>;
  if (typeof row.count === 'number') return row.count;
  if (Array.isArray(row.skills)) return row.skills.length;
  if (Array.isArray(row.items)) return row.items.length;
  return 0;
}
