import { useEffect } from 'react';

import './OMBrainRuntimeCore.css';

export type RuntimeCoreState =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'governance'
  | 'success'
  | 'warning'
  | 'error'
  | 'offline';

export interface RuntimeDetailRow {
  label: string;
  value: string;
}

export interface OMBrainRuntimeCoreProps {
  state: RuntimeCoreState;
  title?: string;
  subtitle?: string;
  version?: string;
  serviceState?: string;
  environment?: string;
  targetHost?: string;
  requestId?: string;
  latencyMs?: number;
  lastChecked?: string;
  healthLabel?: string;
  detailRows?: RuntimeDetailRow[];
  compact?: boolean;
  inFlight?: boolean;
  onRunDiagnostic?: () => void;
  onStateChange?: (state: RuntimeCoreState) => void;
  diagnosticLoading?: boolean;
  /** Visual testing only — never enable in production overlays or Brain Console. */
  demoMode?: boolean;
  /** Match parent shell theme; Brain Console always uses light. */
  appearance?: 'auto' | 'light' | 'dark';
}

const STATE_TABS: RuntimeCoreState[] = [
  'idle',
  'thinking',
  'tool',
  'governance',
  'success',
  'warning',
  'error',
  'offline',
];

const STATE_LABELS: Record<RuntimeCoreState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool: 'Tool',
  governance: 'Governance',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  offline: 'Offline',
};

function formatLatency(ms: number | undefined, inFlight: boolean): string {
  if (inFlight) return '…';
  if (ms == null || ms <= 0) return '—';
  return `${ms} ms`;
}

function latencyProgress(ms: number | undefined, inFlight: boolean): number | null {
  if (inFlight) return null;
  if (ms == null || ms <= 0) return 0;
  return Math.min(100, Math.max(8, (ms / 500) * 100));
}

export default function OMBrainRuntimeCore({
  state,
  title = 'OMBrain Runtime Core',
  subtitle,
  version,
  serviceState,
  environment,
  targetHost,
  requestId,
  latencyMs,
  lastChecked,
  healthLabel,
  detailRows,
  compact = false,
  inFlight = false,
  onRunDiagnostic,
  onStateChange,
  diagnosticLoading = false,
  demoMode = false,
  appearance = 'auto',
}: OMBrainRuntimeCoreProps) {
  const resolvedSubtitle =
    subtitle
    ?? (version && serviceState
      ? `${version} · ${serviceState}`
      : version
        ? version
        : 'Live om-brain status from GET /status');
  useEffect(() => {
    if (!demoMode || !onStateChange) return undefined;

    let idx = STATE_TABS.indexOf(state);
    if (idx < 0) idx = 0;

    const interval = setInterval(() => {
      idx = (idx + 1) % STATE_TABS.length;
      onStateChange(STATE_TABS[idx]!);
    }, 3000);

    return () => clearInterval(interval);
  }, [demoMode, onStateChange]);

  const progress = latencyProgress(latencyMs, inFlight);
  const isLive = state !== 'offline' && state !== 'error';
  const healthTone = healthLabel?.toLowerCase().includes('online')
    || healthLabel?.toLowerCase().includes('reachable')
    || healthLabel?.toLowerCase().includes('healthy')
    ? 'success'
    : healthLabel?.toLowerCase().includes('unavailable')
      || healthLabel?.toLowerCase().includes('offline')
      || healthLabel?.toLowerCase().includes('error')
      ? 'danger'
      : undefined;

  const appearanceClass =
    appearance === 'light'
      ? ' ombrain-runtime-core--light'
      : appearance === 'dark'
        ? ' ombrain-runtime-core--dark'
        : '';

  return (
    <article
      className={`ombrain-runtime-core${compact ? ' ombrain-runtime-core--compact' : ''}${appearanceClass}`}
      data-state={state}
      data-health-tone={healthTone}
      aria-label={`${title} — ${STATE_LABELS[state]}`}
    >
      <header className="ombrain-runtime-core__header">
        <div className="ombrain-runtime-core__title-block">
          <h2 className="ombrain-runtime-core__title">{title}</h2>
          {resolvedSubtitle && <p className="ombrain-runtime-core__subtitle">{resolvedSubtitle}</p>}
        </div>
        <span className="ombrain-runtime-core__live" aria-live="polite">
          <span className="ombrain-runtime-core__live-dot" aria-hidden="true" />
          {isLive ? 'live' : state}
        </span>
      </header>

      <div className="ombrain-runtime-core__body">
        <div className="ombrain-runtime-core__orb-zone" aria-hidden="true">
          <div className="ombrain-runtime-core__ring ombrain-runtime-core__ring--outer" />
          <div className="ombrain-runtime-core__ring ombrain-runtime-core__ring--inner" />
          <div className="ombrain-runtime-core__scan" />
          <div className="ombrain-runtime-core__particles">
            <span className="ombrain-runtime-core__particle" />
            <span className="ombrain-runtime-core__particle" />
            <span className="ombrain-runtime-core__particle" />
          </div>
          <div className="ombrain-runtime-core__orb">
            <svg className="ombrain-runtime-core__orb-neural" viewBox="0 0 60 60" aria-hidden="true">
              <circle cx="30" cy="30" r="3" fill="rgba(255,255,255,0.5)" />
              <circle cx="18" cy="22" r="2" fill="rgba(255,255,255,0.35)" />
              <circle cx="42" cy="24" r="2" fill="rgba(255,255,255,0.35)" />
              <circle cx="24" cy="40" r="2" fill="rgba(255,255,255,0.3)" />
              <circle cx="38" cy="38" r="2" fill="rgba(255,255,255,0.3)" />
              <path
                d="M30 30 L18 22 M30 30 L42 24 M30 30 L24 40 M30 30 L38 38"
                stroke="rgba(255,255,255,0.25)"
                strokeWidth="0.75"
                fill="none"
              />
            </svg>
            <span className="ombrain-runtime-core__orb-center" />
          </div>
        </div>

        <div className="ombrain-runtime-core__meta">
          <p className="ombrain-runtime-core__state-label">{STATE_LABELS[state]}</p>

          {healthLabel && (
            <div className="ombrain-runtime-core__health">
              <span>Health</span>
              <span className="ombrain-runtime-core__health-value">{healthLabel}</span>
            </div>
          )}

          <div className="ombrain-runtime-core__chips">
            {environment && (
              <span className="ombrain-runtime-core__env-chip" title={targetHost}>
                {environment}
              </span>
            )}
            {targetHost && !environment && (
              <span className="ombrain-runtime-core__env-chip">{targetHost}</span>
            )}
          </div>

          <div className="ombrain-runtime-core__row">
            <span className="ombrain-runtime-core__row-label">Request</span>
            <span className="ombrain-runtime-core__row-value" title={requestId}>
              {requestId ?? '—'}
            </span>
          </div>

          <div className="ombrain-runtime-core__row">
            <span className="ombrain-runtime-core__row-label">Latency</span>
            <span className="ombrain-runtime-core__latency">{formatLatency(latencyMs, inFlight)}</span>
          </div>

          {lastChecked && (
            <div className="ombrain-runtime-core__row">
              <span className="ombrain-runtime-core__row-label">Checked</span>
              <span className="ombrain-runtime-core__row-value">{lastChecked}</span>
            </div>
          )}

          {detailRows?.map((row) => (
            <div key={row.label} className="ombrain-runtime-core__row">
              <span className="ombrain-runtime-core__row-label">{row.label}</span>
              <span className="ombrain-runtime-core__row-value">{row.value}</span>
            </div>
          ))}

          <div className="ombrain-runtime-core__progress" role="progressbar" aria-valuenow={progress ?? undefined}>
            <div
              className={`ombrain-runtime-core__progress-bar${inFlight ? ' ombrain-runtime-core__progress-bar--indeterminate' : ''}`}
              style={{ width: inFlight ? undefined : `${progress ?? 0}%` }}
            />
          </div>
        </div>
      </div>

      <footer className="ombrain-runtime-core__footer">
        <div className="ombrain-runtime-core__state-tabs" role="tablist" aria-label="Runtime state">
          {STATE_TABS.map((tab) => {
            const active = tab === state;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                className={`ombrain-runtime-core__state-tab${active ? ' ombrain-runtime-core__state-tab--active' : ''}`}
                disabled={!demoMode || !onStateChange}
                onClick={demoMode ? () => onStateChange?.(tab) : undefined}
              >
                {STATE_LABELS[tab]}
              </button>
            );
          })}
        </div>

        {onRunDiagnostic && (
          <button
            type="button"
            className="ombrain-runtime-core__diagnostic"
            onClick={onRunDiagnostic}
            disabled={diagnosticLoading}
          >
            {diagnosticLoading ? 'Running diagnostic…' : 'Diagnostic'}
          </button>
        )}
      </footer>
    </article>
  );
}
