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
  | 'capabilities'
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

export type ActionQueueSeverity = 'critical' | 'warning' | 'info';

export interface ActionQueueItem {
  id: string;
  severity: ActionQueueSeverity;
  title: string;
  explanation: string;
  recommendedAction: string;
  buttonLabel?: string;
  navigateTo?: SectionId;
  safeToAct: boolean;
}

export type CapabilityCategory =
  | 'Ask / Knowledge'
  | 'Orthodox Calendar & Saints'
  | 'Church Finder'
  | 'Skills Registry'
  | 'Actions'
  | 'Governance'
  | 'Diagnostics'
  | 'Draft Work Items'
  | 'Infrastructure Actions';

export type CapabilityGate = 'Read-only' | 'Human-gated' | 'Proposal-only' | 'Executable' | 'Diagnostic';

export interface CapabilityDetail {
  id: string;
  capability: string;
  category: CapabilityCategory;
  state: 'available' | 'partial' | 'pending' | 'blocked';
  safety: SafetyLevel;
  gate: CapabilityGate;
  note: string;
  lastVerified: string;
  endpoint?: string;
  navigateTo?: SectionId;
  detailBullets?: string[];
}

export interface VerifiedCapabilityItem {
  id: string;
  title: string;
  source: string;
  lastVerified: string;
}

export type VerifiedCapabilityGroupName =
  | 'Runtime'
  | 'Knowledge'
  | 'Governance'
  | 'Actions'
  | 'Fleet / Infrastructure'
  | 'Work Items'
  | 'Docs / Memory';

export interface VerifiedCapabilityGroup {
  group: VerifiedCapabilityGroupName;
  items: VerifiedCapabilityItem[];
}

export type BlockerCategory =
  | 'blocked'
  | 'not-built'
  | 'config-missing'
  | 'security-boundary'
  | 'monitoring-unavailable'
  | 'unknown'
  | 'intentionally-disabled';

export interface BlockerItem {
  id: string;
  category: BlockerCategory;
  name: string;
  impact: string;
  requiredFix: string;
  owner: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface EventDetail {
  id: string;
  kind: 'activity' | 'event';
  title: string;
  endpoint?: string;
  actor?: string;
  timestamp: string;
  latencyMs?: number;
  status?: string;
  safety?: SafetyLevel;
  extra?: { label: string; value: string }[];
}
