import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  inferRuntimeStateFromEndpoint,
  useOMBrainRuntime,
} from '../contexts/OMBrainRuntimeContext';

import {
  activityShowsUpstreamReachable,
  brainRootGet,
  deriveFleetEnvironment,
  formatBrainApiError,
  formatBrainReachabilityError,
  getBrainHealth,
  getConsoleBriefing,
  getProxyHealth,
  listBrainActivity,
  listSkills,
  parseSkillsCount,
  type BrainActivityRecord,
  type BrainHealth,
  type BrainLlmStatus,
  type ProxyHealth,
} from '../api/brainApi';

import type { BriefingModel } from './briefingTypes';
import { executeBrainCall, requestId } from './brainCall';
import type {
  ActivityRow,
  LastRuntimeCall,
  RuntimeCoreState,
  SectionId,
  StatusCardData,
  StatusTone,
} from './types';
import { formatTimestamp } from './brainCall';

function fleetEnvironmentFromProxy(proxy: ProxyHealth | null | undefined): string {
  if (proxy?.fleet_environment) return String(proxy.fleet_environment);
  return deriveFleetEnvironment(proxy?.brain_endpoint);
}

function parseEndpoint(endpoint: string): { method: string; route: string } {
  const parts = endpoint.trim().split(/\s+/);
  if (parts.length >= 2) {
    return { method: parts[0]!, route: parts.slice(1).join(' ') };
  }
  return { method: 'GET', route: endpoint };
}

function isUpstreamHealthy(health: BrainHealth | null): boolean {
  return health != null && health.ok !== false;
}

function mergeBrainHealth(
  upstream: BrainHealth | null,
  governance: BrainHealth | null,
): BrainHealth | null {
  if (!upstream && !governance) return null;
  return {
    ...(governance || {}),
    ...(upstream || {}),
    llm: upstream?.llm || governance?.llm,
    memory_backend: upstream?.memory_backend || governance?.memory_backend,
    executes_actions: upstream?.executes_actions ?? governance?.executes_actions,
  };
}

function resolveHealthLabel(
  consoleOk: boolean,
  upstreamOk: boolean,
  healthError: string | null,
): string {
  if (!consoleOk) return 'Offline';
  if (healthError || !upstreamOk) return 'Degraded';
  if (consoleOk && upstreamOk) return 'Online';
  return 'Unknown';
}

const LLM_STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  disabled: 'Disabled',
  not_configured: 'Not configured',
  degraded: 'Degraded',
  error: 'Error',
};

const LLM_STATUS_TONES: Record<string, StatusTone> = {
  available: 'success',
  disabled: 'warning',
  not_configured: 'neutral',
  degraded: 'warning',
  error: 'danger',
};

function formatLlmCircuit(health: BrainHealth | null): {
  value: string;
  meta: string;
  tone: StatusTone;
} {
  const llm: BrainLlmStatus | undefined = health?.llm;
  if (llm?.status) {
    const metaParts: string[] = [];
    if (llm.memory_backend || health?.memory_backend) {
      metaParts.push(String(llm.memory_backend || health?.memory_backend));
    }
    if (llm.model) metaParts.push(String(llm.model));
    if (llm.last_error && llm.status !== 'available') metaParts.push(String(llm.last_error));
    return {
      value: LLM_STATUS_LABELS[llm.status] || llm.status,
      meta: metaParts.join(' · ') || 'LLM circuit',
      tone: LLM_STATUS_TONES[llm.status] || 'neutral',
    };
  }

  if (health?.llm_endpoint_allowed === true) {
    return {
      value: 'Allowed',
      meta: health.memory_backend ? String(health.memory_backend) : 'memory backend',
      tone: 'info',
    };
  }
  if (health?.llm_endpoint_allowed === false) {
    return {
      value: 'Blocked',
      meta: health.llm_endpoint_reason ? String(health.llm_endpoint_reason) : 'circuit breaker',
      tone: 'warning',
    };
  }

  return { value: 'Unknown', meta: 'awaiting health probe', tone: 'neutral' };
}

function mapActivityRecord(row: BrainActivityRecord): ActivityRow {
  const ts = row.timestamp.includes('T')
    ? row.timestamp.slice(11, 19)
    : row.timestamp.slice(-8);
  return {
    id: row.request_id,
    action: row.label,
    endpoint: `${row.method} ${row.endpoint}`,
    status: row.outcome,
    timestamp: ts,
    latencyMs: row.latency_ms,
    session: row.user_role || 'super_admin',
    safety: row.governance === 'diagnostic' ? 'diagnostic' : 'read-only',
  };
}

interface BrainConsoleContextValue {
  section: SectionId;
  setSection: (id: SectionId) => void;
  proxyHealth: ProxyHealth | null;
  brainHealth: BrainHealth | null;
  healthLoading: boolean;
  healthError: string | null;
  lastChecked: string | null;
  statusCards: StatusCardData[];
  activity: ActivityRow[];
  pushActivity: (row: ActivityRow) => void;
  runBrainCall: <T>(
    opts: Parameters<typeof executeBrainCall<T>>[0],
    runtimeState?: RuntimeCoreState,
  ) => Promise<Awaited<ReturnType<typeof executeBrainCall<T>>>>;
  runtimeState: RuntimeCoreState;
  callInFlight: boolean;
  lastRuntimeCall: LastRuntimeCall | null;
  refreshHealth: (opts?: { manual?: boolean }) => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshKey: number;
  snapshot: ReturnType<typeof useOMBrainRuntime>['snapshot'];
  briefing: BriefingModel | null;
  briefingLoading: boolean;
  briefingError: string | null;
  refreshBriefing: () => Promise<void>;
}

const BrainConsoleContext = createContext<BrainConsoleContextValue | null>(null);

function toneFromBool(ok: boolean | undefined, fallback: StatusTone = 'neutral'): StatusTone {
  if (ok === true) return 'success';
  if (ok === false) return 'danger';
  return fallback;
}

export function BrainConsoleProvider({
  section,
  setSection,
  children,
}: {
  section: SectionId;
  setSection: (id: SectionId) => void;
  children: ReactNode;
}) {
  const { snapshot, runtime } = useOMBrainRuntime();

  const [proxyHealth, setProxyHealth] = useState<ProxyHealth | null>(null);
  const [brainHealth, setBrainHealth] = useState<BrainHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [lastRuntimeCall, setLastRuntimeCall] = useState<LastRuntimeCall | null>(null);
  const [briefing, setBriefing] = useState<BriefingModel | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);

  const refreshBriefing = useCallback(async () => {
    setBriefingLoading(true);
    try {
      const data = await getConsoleBriefing<BriefingModel>();
      setBriefing(data);
      setBriefingError(null);
    } catch (err) {
      setBriefingError(formatBrainApiError(err));
    } finally {
      setBriefingLoading(false);
    }
  }, []);

  const pushActivity = useCallback((row: ActivityRow) => {
    const { method, route } = parseEndpoint(row.endpoint);
    setActivity((prev) => [row, ...prev].slice(0, 50));
    setLastLatency(row.latencyMs);
    setLastRuntimeCall({
      method,
      route,
      requestId: row.id,
      latencyMs: row.latencyMs,
      safety: row.safety,
      timestamp: row.timestamp,
      status: row.status,
    });
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const data = await listBrainActivity(50);
      setActivity((data.activity || []).map(mapActivityRecord));
    } catch {
      // keep in-session rows when activity API unavailable
    }
  }, []);

  const runBrainCall = useCallback(
    async <T,>(
      opts: Parameters<typeof executeBrainCall<T>>[0],
      runtimeStateOverride?: RuntimeCoreState,
    ) => {
      const activeState =
        runtimeStateOverride ?? inferRuntimeStateFromEndpoint(opts.endpoint, opts.action);
      const reqId = requestId();

      return runtime.withRuntimeState(
        {
          state: activeState,
          label: opts.action,
          requestId: reqId,
          source: 'brain-console',
        },
        async () => {
          const out = await executeBrainCall(opts);
          pushActivity(out.activity);
          void refreshActivity();

          if (out.activity.status === 'error') {
            throw new Error(out.result.error ?? out.result.summary);
          }

          return out;
        },
        (out) => ({
          latencyMs: out.activity.latencyMs,
          message: out.result.summary,
          state: out.activity.status === 'warning' ? 'warning' : 'success',
        }),
      );
    },
    [pushActivity, refreshActivity, runtime],
  );

  const refreshHealth = useCallback(
    async (opts?: { manual?: boolean }) => {
      const manual = opts?.manual ?? false;

      if (manual) {
        setHealthLoading(true);
        setHealthError(null);
      }

      const runCheck = async () => {
        const healthStarted = performance.now();
        const healthReqId = requestId();
        let localHealthError: string | null = null;

        setHealthError(null);

        const proxy = await getProxyHealth();
        setProxyHealth(proxy);
        const fleetEnvironment = fleetEnvironmentFromProxy(proxy);

        let upstreamOk = false;
        let mergedHealth: BrainHealth | null = null;
        let primaryProbeError: unknown = null;

        const [upstreamResult, governanceResult] = await Promise.all([
          getBrainHealth().catch((err) => ({ __error: err as unknown })),
          brainRootGet<BrainHealth>('/governance/health').catch((err) => ({ __error: err as unknown })),
        ]);

        if (!('__error' in upstreamResult)) {
          mergedHealth = mergeBrainHealth(upstreamResult, !('__error' in (governanceResult || {})) ? governanceResult : null);
          setBrainHealth(mergedHealth);
          upstreamOk = isUpstreamHealthy(mergedHealth);
        } else {
          primaryProbeError = upstreamResult.__error;
          if (governanceResult && !('__error' in governanceResult)) {
            mergedHealth = mergeBrainHealth(null, governanceResult);
            setBrainHealth(mergedHealth);
            upstreamOk = isUpstreamHealthy(mergedHealth);
          } else if (governanceResult && '__error' in governanceResult && !primaryProbeError) {
            primaryProbeError = governanceResult.__error;
          }
        }

        let skillsOk = false;
        try {
          const skills = await listSkills();
          setSkillCount(parseSkillsCount(skills));
          skillsOk = true;
        } catch (skillsErr) {
          setSkillCount(null);
          if (!primaryProbeError) primaryProbeError = skillsErr;
        }

        let activityRows: BrainActivityRecord[] = [];
        try {
          const activityData = await listBrainActivity(20);
          activityRows = activityData.activity || [];
          setActivity(activityRows.map(mapActivityRecord));
        } catch {
          // keep in-session rows when activity API unavailable
        }

        const activityCorroborates = activityShowsUpstreamReachable(activityRows);

        if (!upstreamOk && (skillsOk || activityCorroborates)) {
          const via = skillsOk ? '/brain/skills' : 'recent proxy activity';
          mergedHealth = mergedHealth || {
            ok: true,
            note: `Reachable via ${via} (structured /health probe failed)`,
          };
          setBrainHealth(mergedHealth);
          upstreamOk = true;
          localHealthError = null;
          setHealthError(null);
        } else if (!upstreamOk) {
          setBrainHealth(mergedHealth);
          upstreamOk = false;
          localHealthError = formatBrainReachabilityError(primaryProbeError ?? new Error('No successful health probe'));
          setHealthError(localHealthError);
        }

        const checkedAt = formatTimestamp();
        setLastChecked(checkedAt);
        setRefreshKey((k) => k + 1);
        const latencyMs = Math.round(performance.now() - healthStarted);
        setLastLatency(latencyMs);

        const proxyOk = proxy?.ok === true;
        const targetHost = proxy?.brain_endpoint ? String(proxy.brain_endpoint) : undefined;
        const checkDegraded = proxyOk && (!upstreamOk || Boolean(localHealthError));

        if (upstreamOk && !localHealthError) {
          setHealthError(null);
        }

        runtime.setHealth({
          healthLabel: resolveHealthLabel(proxyOk, upstreamOk, localHealthError),
          latencyMs,
          lastChecked: checkedAt,
          environment: fleetEnvironment,
          targetHost,
          checkSucceeded: upstreamOk,
          checkDegraded: !upstreamOk || Boolean(localHealthError),
        });

        setLastRuntimeCall({
          method: 'GET',
          route: '/api/brain/health',
          requestId: healthReqId,
          latencyMs,
          safety: 'diagnostic',
          timestamp: formatTimestamp().slice(11, 19),
          status: upstreamOk && !localHealthError ? 'success' : localHealthError ? 'warning' : 'error',
        });

        void refreshActivity();

        return { latencyMs, proxyOk, healthReqId };
      };

      try {
        if (manual) {
          await runtime.withRuntimeState(
            {
              state: 'tool',
              label: 'Health check',
              requestId: requestId(),
              source: 'brain-console',
            },
            runCheck,
            (result) => ({
              latencyMs: result.latencyMs,
              message: 'Health check OK',
            }),
          );
          void refreshBriefing();
        } else {
          await runCheck();
        }
      } catch (err) {
        const message = formatBrainApiError(err);
        setHealthError(message);
        if (!proxyHealth) {
          setBrainHealth(null);
        }
        runtime.setHealth({
          healthLabel: 'Offline',
          lastChecked: formatTimestamp(),
          environment: fleetEnvironmentFromProxy(proxyHealth),
          checkSucceeded: false,
        });
        if (manual) {
          throw err;
        }
      } finally {
        if (manual) {
          setHealthLoading(false);
        }
      }
    },
    [refreshActivity, refreshBriefing, runtime],
  );

  const statusCards = useMemo((): StatusCardData[] => {
    const upstreamOk = isUpstreamHealthy(brainHealth);
    const consoleOk = proxyHealth?.ok === true;
    const healthTone: StatusTone =
      consoleOk && upstreamOk && !healthError ? 'success' : consoleOk ? 'warning' : 'danger';
    const llmCircuit = formatLlmCircuit(brainHealth);

    return [
      {
        id: 'health',
        label: 'Brain Health',
        value: healthTone === 'success' ? 'Online' : healthTone === 'warning' ? 'Degraded' : 'Offline',
        meta: proxyHealth?.brain_endpoint ? String(proxyHealth.brain_endpoint) : '127.0.0.1:8390',
        tone: healthTone,
        icon: 'activity',
      },
      {
        id: 'registry',
        label: 'Console Proxy',
        value: consoleOk ? 'Local' : 'Error',
        meta: proxyHealth?.service ?? 'om-brain-console',
        tone: toneFromBool(consoleOk, 'neutral'),
        icon: 'network',
      },
      {
        id: 'transport',
        label: 'LLM Circuit',
        value: llmCircuit.value,
        meta: llmCircuit.meta,
        tone: llmCircuit.tone,
        icon: 'network',
      },
      {
        id: 'skills',
        label: 'Skills Registered',
        value: skillCount != null ? String(skillCount) : '—',
        meta: 'GET /brain/skills',
        tone: 'info',
        icon: 'boxes',
      },
      {
        id: 'governance',
        label: 'Governance Mode',
        value: brainHealth?.executes_actions ? 'Executes' : 'Auditor',
        meta: 'OMStudio handoff when required',
        tone: brainHealth?.executes_actions ? 'warning' : 'success',
        icon: 'shield',
      },
      {
        id: 'latency',
        label: 'Last Action Latency',
        value: lastLatency != null ? `${lastLatency} ms` : '—',
        meta: lastChecked ? `checked ${lastChecked.slice(11, 19)} UTC` : 'no actions yet',
        tone: 'neutral',
        icon: 'gauge',
      },
    ];
  }, [brainHealth, healthError, lastChecked, lastLatency, proxyHealth, skillCount]);

  const value = useMemo(
    () => ({
      section,
      setSection,
      proxyHealth,
      brainHealth,
      healthLoading,
      healthError,
      lastChecked,
      statusCards,
      activity,
      pushActivity,
      runBrainCall,
      runtimeState: snapshot.state,
      callInFlight: snapshot.inFlight || healthLoading,
      lastRuntimeCall,
      refreshHealth,
      refreshActivity,
      refreshKey,
      snapshot,
      briefing,
      briefingLoading,
      briefingError,
      refreshBriefing,
    }),
    [
      section,
      setSection,
      proxyHealth,
      brainHealth,
      healthLoading,
      healthError,
      lastChecked,
      statusCards,
      activity,
      pushActivity,
      runBrainCall,
      snapshot.state,
      snapshot.inFlight,
      snapshot,
      lastRuntimeCall,
      refreshHealth,
      refreshActivity,
      refreshKey,
      briefing,
      briefingLoading,
      briefingError,
      refreshBriefing,
    ],
  );

  return <BrainConsoleContext.Provider value={value}>{children}</BrainConsoleContext.Provider>;
}

export function useBrainConsole(): BrainConsoleContextValue {
  const ctx = useContext(BrainConsoleContext);
  if (!ctx) throw new Error('useBrainConsole must be used within BrainConsoleProvider');
  return ctx;
}
