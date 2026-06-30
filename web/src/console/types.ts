export type SafetyLevel =
  | 'read-only'
  | 'diagnostic'
  | 'proposal-only'
  | 'human-gated'
  | 'blocked';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export type RuntimeCoreState =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'governance'
  | 'success'
  | 'warning'
  | 'error'
  | 'offline';

export interface LastRuntimeCall {
  method: string;
  route: string;
  requestId: string;
  latencyMs: number;
  safety: SafetyLevel;
  timestamp: string;
  status: ActivityRow['status'];
}

export type SectionId =
  | 'overview'
  | 'ask'
  | 'calendar'
  | 'theology'
  | 'churches'
  | 'skills'
  | 'actions'
  | 'teach'
  | 'diagnostics'
  | 'decisions'
  | 'events'
  | 'governance'
  | 'raw';

export interface StatusCardData {
  id: string;
  label: string;
  value: string;
  meta: string;
  tone: StatusTone;
  icon: 'activity' | 'boxes' | 'network' | 'shield' | 'gauge';
}

export interface ActivityRow {
  id: string;
  action: string;
  endpoint: string;
  status: 'success' | 'error' | 'pending' | 'warning';
  timestamp: string;
  latencyMs: number;
  session: string;
  safety: SafetyLevel;
}

export interface CapabilityMatrixItem {
  id: string;
  capability: string;
  state: 'available' | 'partial' | 'pending' | 'blocked';
  safety: SafetyLevel;
  note: string;
}

export interface ResultData {
  status: 'success' | 'error' | 'pending' | 'warning';
  endpoint: string;
  requestId: string;
  latencyMs: number;
  timestamp: string;
  summary: string;
  json: unknown;
  error?: string;
}

export interface DiagnosticItem {
  id: string;
  name: string;
  description: string;
  state: 'operational' | 'degraded' | 'down' | 'pending';
  lastCheck: string;
  recommendedAction: string;
  severity: 'info' | 'warning' | 'critical';
}
