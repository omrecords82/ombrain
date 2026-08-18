import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

import type { RuntimeCoreState } from '../components/ombrain/OMBrainRuntimeCore';

export type HealthStatus = 'online' | 'degraded' | 'offline' | 'unknown';

const STATE_PRIORITY: Record<RuntimeCoreState, number> = {
  offline: 8,
  error: 7,
  governance: 6,
  tool: 5,
  thinking: 4,
  warning: 3,
  success: 2,
  idle: 1,
};

const SUCCESS_IDLE_MS = 4000;
const ERROR_IDLE_MS = 10000;
const OFFLINE_FAILURE_THRESHOLD = 2;

export function inferRuntimeStateFromEndpoint(endpoint: string, action: string): RuntimeCoreState {
  const key = `${endpoint} ${action}`.toLowerCase();
  if (/governance|decisions|approval/.test(key)) return 'governance';
  if (/ask|theology/.test(key)) return 'thinking';
  if (/health|skills|skill|diagnostic/.test(key)) return 'tool';
  return 'tool';
}

function pickHigherState(a: RuntimeCoreState, b: RuntimeCoreState): RuntimeCoreState {
  return STATE_PRIORITY[a] >= STATE_PRIORITY[b] ? a : b;
}

export interface RuntimeAction {
  id: string;
  source: string;
  label: string;
  state: RuntimeCoreState;
  startedAt: number;
  requestId?: string;
  actionSeq: number;
}

export interface OMBrainRuntimeState {
  visualState: RuntimeCoreState;
  healthStatus: HealthStatus;
  activeAction?: RuntimeAction;
  lastAction?: RuntimeAction;
  healthLabel?: string;
  environment?: string;
  targetHost?: string;
  requestId?: string;
  latencyMs?: number;
  lastChecked?: string;
  consecutiveHealthFailures: number;
  consecutiveHealthSuccesses: number;
  message?: string;
  transientState?: RuntimeCoreState;
}

function resolveVisualState(state: OMBrainRuntimeState): RuntimeCoreState {
  if (state.healthStatus === 'offline') return 'offline';

  let resolved: RuntimeCoreState = 'idle';

  if (state.transientState === 'error') {
    resolved = pickHigherState(resolved, 'error');
  }

  if (state.activeAction) {
    resolved = pickHigherState(resolved, state.activeAction.state);
  }

  if (state.transientState && state.transientState !== 'error') {
    resolved = pickHigherState(resolved, state.transientState);
  }

  if (state.healthStatus === 'degraded') {
    resolved = pickHigherState(resolved, 'warning');
  }

  return resolved;
}

function withVisualState(state: OMBrainRuntimeState): OMBrainRuntimeState {
  return { ...state, visualState: resolveVisualState(state) };
}

const initialRuntimeState: OMBrainRuntimeState = {
  visualState: 'idle',
  healthStatus: 'unknown',
  consecutiveHealthFailures: 0,
  consecutiveHealthSuccesses: 0,
};

type RuntimeReducerAction =
  | {
      type: 'START';
      payload: {
        actionSeq: number;
        id: string;
        state: RuntimeCoreState;
        label: string;
        source: string;
        requestId?: string;
      };
    }
  | {
      type: 'COMPLETE';
      payload: {
        actionSeq: number;
        state?: 'success' | 'warning';
        latencyMs?: number;
        message?: string;
      };
    }
  | {
      type: 'FAIL';
      payload: {
        actionSeq: number;
        message?: string;
        requestId?: string;
      };
    }
  | {
      type: 'SET_HEALTH';
      payload: {
        healthLabel?: string;
        latencyMs?: number;
        lastChecked?: string;
        environment?: string;
        targetHost?: string;
        checkSucceeded?: boolean;
        checkDegraded?: boolean;
      };
    }
  | { type: 'CLEAR_TRANSIENT' }
  | { type: 'RESET_TO_IDLE' };

function runtimeReducer(state: OMBrainRuntimeState, action: RuntimeReducerAction): OMBrainRuntimeState {
  switch (action.type) {
    case 'START': {
      const { actionSeq, id, state: runState, label, source, requestId } = action.payload;
      const activeAction: RuntimeAction = {
        id,
        source,
        label,
        state: runState,
        startedAt: performance.now(),
        requestId,
        actionSeq,
      };
      return withVisualState({
        ...state,
        activeAction,
        transientState: undefined,
        message: undefined,
        requestId: requestId ?? state.requestId,
      });
    }

    case 'COMPLETE': {
      const { actionSeq, state: outcome = 'success', latencyMs, message } = action.payload;
      if (!state.activeAction || state.activeAction.actionSeq !== actionSeq) return state;

      const finished = state.activeAction;
      return withVisualState({
        ...state,
        activeAction: undefined,
        lastAction: finished,
        transientState: outcome,
        latencyMs: latencyMs ?? state.latencyMs,
        message,
        requestId: finished.requestId ?? state.requestId,
      });
    }

    case 'FAIL': {
      const { actionSeq, message, requestId } = action.payload;
      if (!state.activeAction || state.activeAction.actionSeq !== actionSeq) return state;

      const finished = state.activeAction;
      return withVisualState({
        ...state,
        activeAction: undefined,
        lastAction: finished,
        transientState: 'error',
        message,
        requestId: requestId ?? finished.requestId ?? state.requestId,
      });
    }

    case 'SET_HEALTH': {
      const { checkSucceeded, checkDegraded, healthLabel, latencyMs, lastChecked, environment, targetHost } =
        action.payload;

      let consecutiveHealthFailures = state.consecutiveHealthFailures;
      let consecutiveHealthSuccesses = state.consecutiveHealthSuccesses;
      let healthStatus = state.healthStatus;

      if (checkSucceeded === true) {
        consecutiveHealthFailures = 0;
        consecutiveHealthSuccesses += 1;
        healthStatus = checkDegraded ? 'degraded' : 'online';
      } else if (checkSucceeded === false) {
        consecutiveHealthSuccesses = 0;
        consecutiveHealthFailures += 1;
        if (consecutiveHealthFailures >= OFFLINE_FAILURE_THRESHOLD) {
          healthStatus = 'offline';
        }
      }

      const next: OMBrainRuntimeState = {
        ...state,
        healthStatus,
        consecutiveHealthFailures,
        consecutiveHealthSuccesses,
        healthLabel: healthLabel ?? state.healthLabel,
        latencyMs: latencyMs ?? state.latencyMs,
        lastChecked: lastChecked ?? state.lastChecked,
        environment: environment ?? state.environment,
        targetHost: targetHost ?? state.targetHost,
      };

      if (checkSucceeded === true && healthStatus !== 'offline' && next.transientState === undefined && !next.activeAction) {
        // Health-only metadata update — do not force tool/thinking visual states.
      }

      return withVisualState(next);
    }

    case 'CLEAR_TRANSIENT':
      if (!state.transientState) return state;
      return withVisualState({ ...state, transientState: undefined, message: undefined });

    case 'RESET_TO_IDLE':
      return withVisualState({
        ...state,
        activeAction: undefined,
        transientState: undefined,
        message: undefined,
      });

    default:
      return state;
  }
}

export interface OMBrainRuntimeSnapshot {
  state: RuntimeCoreState;
  label?: string;
  requestId?: string;
  source?: string;
  latencyMs?: number;
  message?: string;
  inFlight: boolean;
  inFlightCount: number;
  healthLabel?: string;
  lastChecked?: string;
  environment?: string;
  targetHost?: string;
  healthStatus: HealthStatus;
}

export interface RuntimeStartOpts {
  state: RuntimeCoreState;
  label?: string;
  requestId?: string;
  source?: string;
}

export interface RuntimeCompleteOpts {
  actionId?: number;
  state?: 'success' | 'warning';
  latencyMs?: number;
  message?: string;
}

export interface RuntimeFailOpts {
  actionId?: number;
  message?: string;
  requestId?: string;
}

export interface RuntimeHealthOpts {
  healthStatus?: HealthStatus;
  healthLabel?: string;
  latencyMs?: number;
  lastChecked?: string;
  environment?: string;
  targetHost?: string;
  checkSucceeded?: boolean;
  checkDegraded?: boolean;
}

export interface OMBrainRuntimeController {
  start: (opts: RuntimeStartOpts) => number;
  complete: (opts?: RuntimeCompleteOpts) => void;
  fail: (opts?: RuntimeFailOpts) => void;
  setHealth: (opts: RuntimeHealthOpts) => void;
  resetToIdle: () => void;
  withRuntimeState: <T>(
    opts: RuntimeStartOpts,
    fn: () => Promise<T>,
    onSuccess?: (result: T) => RuntimeCompleteOpts | void,
  ) => Promise<T>;
}

interface OMBrainRuntimeContextValue {
  snapshot: OMBrainRuntimeSnapshot;
  runtime: OMBrainRuntimeController;
  internalState: OMBrainRuntimeState;
}

const OMBrainRuntimeContext = createContext<OMBrainRuntimeContextValue | null>(null);

export function OMBrainRuntimeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(runtimeReducer, initialRuntimeState);
  const actionSeqRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerActionSeqRef = useRef(0);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const scheduleTransientClear = useCallback(
    (fromState: RuntimeCoreState, ms: number, actionSeq: number) => {
      clearIdleTimer();
      timerActionSeqRef.current = actionSeq;
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        if (timerActionSeqRef.current !== actionSeq) return;
        if (actionSeqRef.current > actionSeq) return;
        dispatch({ type: 'CLEAR_TRANSIENT' });
      }, ms);
    },
    [clearIdleTimer],
  );

  const start = useCallback(
    (opts: RuntimeStartOpts): number => {
      clearIdleTimer();
      const actionSeq = ++actionSeqRef.current;
      const id = `act_${actionSeq}`;
      dispatch({
        type: 'START',
        payload: {
          actionSeq,
          id,
          state: opts.state,
          label: opts.label ?? opts.state,
          source: opts.source ?? 'runtime',
          requestId: opts.requestId ?? `req_${actionSeq}`,
        },
      });
      return actionSeq;
    },
    [clearIdleTimer],
  );

  const complete = useCallback(
    (opts: RuntimeCompleteOpts = {}) => {
      const actionSeq = opts.actionId ?? actionSeqRef.current;
      if (actionSeqRef.current !== actionSeq) return;

      dispatch({
        type: 'COMPLETE',
        payload: {
          actionSeq,
          state: opts.state,
          latencyMs: opts.latencyMs,
          message: opts.message,
        },
      });

      const outcome = opts.state ?? 'success';
      scheduleTransientClear(outcome, SUCCESS_IDLE_MS, actionSeq);
    },
    [scheduleTransientClear],
  );

  const fail = useCallback(
    (opts: RuntimeFailOpts = {}) => {
      const actionSeq = opts.actionId ?? actionSeqRef.current;
      if (actionSeqRef.current !== actionSeq) return;

      dispatch({
        type: 'FAIL',
        payload: {
          actionSeq,
          message: opts.message,
          requestId: opts.requestId,
        },
      });

      scheduleTransientClear('error', ERROR_IDLE_MS, actionSeq);
    },
    [scheduleTransientClear],
  );

  const setHealth = useCallback((opts: RuntimeHealthOpts) => {
    dispatch({
      type: 'SET_HEALTH',
      payload: {
        healthLabel: opts.healthLabel,
        latencyMs: opts.latencyMs,
        lastChecked: opts.lastChecked,
        environment: opts.environment,
        targetHost: opts.targetHost,
        checkSucceeded: opts.checkSucceeded,
        checkDegraded: opts.checkDegraded,
      },
    });
  }, []);

  const resetToIdle = useCallback(() => {
    clearIdleTimer();
    dispatch({ type: 'RESET_TO_IDLE' });
  }, [clearIdleTimer]);

  const withRuntimeState = useCallback(
    async <T,>(
      opts: RuntimeStartOpts,
      fn: () => Promise<T>,
      onSuccess?: (result: T) => RuntimeCompleteOpts | void,
    ): Promise<T> => {
      const started = performance.now();
      const actionSeq = start(opts);
      try {
        const result = await fn();
        if (actionSeqRef.current !== actionSeq) return result;

        const extra = onSuccess?.(result);
        complete({
          actionId: actionSeq,
          latencyMs: extra?.latencyMs ?? Math.round(performance.now() - started),
          message: extra?.message ?? 'Request completed',
          state: extra?.state,
        });
        return result;
      } catch (err) {
        if (actionSeqRef.current === actionSeq) {
          fail({ actionId: actionSeq, message: String(err) });
        }
        throw err;
      }
    },
    [complete, fail, start],
  );

  const runtime = useMemo<OMBrainRuntimeController>(
    () => ({
      start,
      complete,
      fail,
      setHealth,
      resetToIdle,
      withRuntimeState,
    }),
    [complete, fail, resetToIdle, setHealth, start, withRuntimeState],
  );

  const snapshot = useMemo<OMBrainRuntimeSnapshot>(
    () => ({
      state: state.visualState,
      label: state.activeAction?.label ?? state.lastAction?.label,
      requestId: state.requestId,
      source: state.activeAction?.source ?? state.lastAction?.source,
      latencyMs: state.latencyMs,
      message: state.message,
      inFlight: Boolean(state.activeAction),
      inFlightCount: state.activeAction ? 1 : 0,
      healthLabel: state.healthLabel,
      lastChecked: state.lastChecked,
      environment: state.environment,
      targetHost: state.targetHost,
      healthStatus: state.healthStatus,
    }),
    [state],
  );

  const value = useMemo(
    () => ({
      snapshot,
      runtime,
      internalState: state,
    }),
    [runtime, snapshot, state],
  );

  return <OMBrainRuntimeContext.Provider value={value}>{children}</OMBrainRuntimeContext.Provider>;
}

export function useOMBrainRuntime(): OMBrainRuntimeContextValue {
  const ctx = useContext(OMBrainRuntimeContext);
  if (!ctx) {
    throw new Error('useOMBrainRuntime must be used within OMBrainRuntimeProvider');
  }
  return ctx;
}

export function useOptionalOMBrainRuntime(): OMBrainRuntimeContextValue | null {
  return useContext(OMBrainRuntimeContext);
}
