import type { SectionId } from './types';

export type OverallState = 'nominal' | 'degraded' | 'offline' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';
export type QueueSeverity = 'critical' | 'warning' | 'info';

export interface BriefingExecutiveSummary {
  headline: string;
  explanation: string;
  changed_since_last_check: string;
  operator_attention_required: boolean;
  confidence: Confidence;
}

export interface BriefingHealthVerdict {
  brain_online: boolean;
  console_proxy_online: boolean;
  llm_available: boolean;
  governance_mode: string;
  skills_registered: number | null;
  last_action_latency_ms: number | null;
  verdict: OverallState;
  reason: string;
}

export interface BriefingOperatorAction {
  id: string;
  severity: QueueSeverity;
  title: string;
  explanation: string;
  recommended_action: string;
  button_label?: string;
  navigate_to?: SectionId;
  safe_to_act: boolean;
}

export interface BriefingIncident {
  id: string;
  title: string;
  explanation: string;
  recommended_action: string;
  first_seen: string;
  last_seen: string;
  navigate_to?: SectionId;
}

export interface BriefingChange {
  id: string;
  summary: string;
  observed_at: string;
  severity: QueueSeverity;
}

export type CapabilityReadinessState = 'available' | 'partial' | 'pending' | 'blocked';

export interface BriefingCapabilityReadiness {
  id: string;
  capability: string;
  category: string;
  gate: string;
  state: CapabilityReadinessState;
  reason: string;
  last_verified: string;
}

export type EventClassification = 'signal' | 'expected_noise' | 'duplicate' | 'low_value_audit' | 'requires_attention';

export interface BriefingEventCluster {
  id: string;
  title: string;
  count: number;
  first_seen: string;
  last_seen: string;
  severity: string;
  impact: string;
  likely_cause: string;
  recommended_action: string;
  confidence: Confidence;
  classification_summary: EventClassification;
  evidence_ids: (string | number)[];
}

export interface BriefingSuppressedNoise {
  pattern: string;
  classification: EventClassification;
  count: number;
  reason: string;
}

export interface BriefingEvidenceLink {
  label: string;
  endpoint: string;
}

export interface BriefingRawSourceStatus {
  source: string;
  label: string;
  endpoint: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

export interface BriefingModel {
  generated_at: string;
  overall_state: OverallState;
  executive_summary: BriefingExecutiveSummary;
  health_verdict: BriefingHealthVerdict;
  operator_actions: BriefingOperatorAction[];
  active_incidents: BriefingIncident[];
  recent_changes: BriefingChange[];
  capability_readiness: BriefingCapabilityReadiness[];
  event_clusters: BriefingEventCluster[];
  suppressed_noise: BriefingSuppressedNoise[];
  evidence_links: BriefingEvidenceLink[];
  raw_source_status: BriefingRawSourceStatus[];
}
