import { formatBrainApiError } from '../api/brainApi';

import { extractBrainProse } from './brainResponseFormat';
import type { ActivityRow, ResultData, SafetyLevel } from './types';

export function requestId(): string {
  return `req_${Math.random().toString(36).slice(2, 10)}`;
}

export function formatTimestamp(d = new Date()): string {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function formatTimeShort(d = new Date()): string {
  return d.toISOString().slice(11, 19);
}

function resultStatus(err: unknown, data: unknown): ResultData['status'] {
  if (err) return 'error';
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (obj.degraded === true || obj.mode === 'cache_only') return 'warning';
    if (obj.ok === false) return 'error';
  }
  return 'success';
}

export async function executeBrainCall<T>(opts: {
  endpoint: string;
  action: string;
  safety: SafetyLevel;
  call: () => Promise<T>;
  summary?: (data: T) => string;
}): Promise<{ result: ResultData; activity: ActivityRow }> {
  const started = performance.now();
  const reqId = requestId();
  const ts = new Date();

  try {
    const data = await opts.call();
    const latencyMs = Math.round(performance.now() - started);
    const summary =
      opts.summary?.(data) ??
      extractBrainProse(data) ??
      'Request completed successfully. Toggle raw JSON for full payload.';

    const result: ResultData = {
      status: resultStatus(null, data),
      endpoint: opts.endpoint,
      requestId: reqId,
      latencyMs,
      timestamp: formatTimestamp(ts),
      summary,
      json: data,
    };

    return {
      result,
      activity: {
        id: reqId,
        action: opts.action,
        endpoint: opts.endpoint,
        status: result.status === 'error' ? 'error' : result.status === 'warning' ? 'warning' : 'success',
        timestamp: formatTimeShort(ts),
        latencyMs,
        session: 'super_admin',
        safety: opts.safety,
      },
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const message = formatBrainApiError(err);
    const result: ResultData = {
      status: 'error',
      endpoint: opts.endpoint,
      requestId: reqId,
      latencyMs,
      timestamp: formatTimestamp(ts),
      summary: message,
      json: err,
      error: message,
    };

    return {
      result,
      activity: {
        id: reqId,
        action: opts.action,
        endpoint: opts.endpoint,
        status: 'error',
        timestamp: formatTimeShort(ts),
        latencyMs,
        session: 'super_admin',
        safety: opts.safety,
      },
    };
  }
}
