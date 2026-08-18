import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from '@mui/material';

import OMBrainRuntimeCore from '../../components/ombrain/OMBrainRuntimeCore';
import {
  deriveFleetEnvironment,
  formatBrainUptime,
  getBrainRuntimeStatus,
  type BrainRuntimeStatus,
} from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { useColorMode } from '../../theme/ColorModeContext';
import { ConsolePanel } from './ConsolePanel';

const TARGET_HOST = '192.168.1.254:8390';

function buildDetailRows(
  status: BrainRuntimeStatus | null,
  lastActionLabel: string | undefined,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];

  if (lastActionLabel) {
    rows.push({ label: 'Last action', value: lastActionLabel });
  }

  if (!status) return rows;

  if (status.memory_backend) {
    rows.push({ label: 'Memory', value: String(status.memory_backend) });
  }

  if (status.llm?.status) {
    rows.push({ label: 'LLM', value: String(status.llm.status) });
  }

  if (status.nats?.configured) {
    const natsLabel = status.nats.state
      ? `${status.nats.state}${status.nats.url_host ? ` (${status.nats.url_host})` : ''}`
      : 'configured';
    rows.push({ label: 'NATS', value: natsLabel });
  } else if (status.nats) {
    rows.push({ label: 'NATS', value: 'not configured' });
  }

  const uptime = formatBrainUptime(status.uptime_sec);
  if (uptime) {
    rows.push({ label: 'Uptime', value: uptime });
  }

  if (status.hostname) {
    rows.push({ label: 'Host', value: String(status.hostname) });
  }

  if (status.executes_actions != null) {
    rows.push({ label: 'Mode', value: status.executes_actions ? 'executes actions' : 'auditor' });
  }

  return rows;
}

export default function RuntimeCorePanel({ compact = false }: { compact?: boolean }) {
  const { mode } = useColorMode();
  const {
    proxyHealth,
    healthLoading,
    runtimeState,
    callInFlight,
    lastRuntimeCall,
    lastChecked,
    refreshHealth,
    snapshot,
  } = useBrainConsole();

  const [runtimeStatus, setRuntimeStatus] = useState<BrainRuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const status = await getBrainRuntimeStatus();
      setRuntimeStatus(status);
      setStatusError(null);
    } catch (err) {
      setRuntimeStatus(null);
      setStatusError(String(err));
    }
  }, []);

  useEffect(() => {
    void loadRuntimeStatus();
  }, [loadRuntimeStatus, lastChecked]);

  const handleDiagnostic = useCallback(() => {
    void refreshHealth({ manual: true });
    void loadRuntimeStatus();
  }, [loadRuntimeStatus, refreshHealth]);

  const checkedLabel = lastChecked ? lastChecked.slice(11, 19) : undefined;
  const fleetEnvironment =
    proxyHealth?.fleet_environment
    ?? deriveFleetEnvironment(proxyHealth?.brain_endpoint)
    ?? snapshot.environment
    ?? 'om-dev-254';

  const lastActionLabel = lastRuntimeCall ? `${lastRuntimeCall.method} ${lastRuntimeCall.route}` : snapshot.label;

  const detailRows = useMemo(
    () => buildDetailRows(runtimeStatus, lastActionLabel),
    [runtimeStatus, lastActionLabel],
  );

  const versionLabel = runtimeStatus?.version
    ? `om-brain ${runtimeStatus.version}`
    : runtimeStatus?.service
      ? String(runtimeStatus.service)
      : undefined;

  const serviceState = runtimeStatus?.state ? String(runtimeStatus.state) : undefined;

  const healthLabel = statusError ? 'Status unavailable' : snapshot.healthLabel;

  const core = (
    <OMBrainRuntimeCore
      state={runtimeState}
      version={versionLabel}
      serviceState={serviceState}
      environment={fleetEnvironment}
      targetHost={proxyHealth?.brain_endpoint ? String(proxyHealth.brain_endpoint) : TARGET_HOST}
      requestId={lastRuntimeCall?.requestId ?? snapshot.requestId}
      latencyMs={lastRuntimeCall?.latencyMs ?? snapshot.latencyMs}
      lastChecked={checkedLabel}
      healthLabel={healthLabel}
      detailRows={detailRows}
      inFlight={callInFlight || healthLoading}
      onRunDiagnostic={handleDiagnostic}
      diagnosticLoading={healthLoading}
      demoMode={false}
      appearance={mode === 'dark' ? 'dark' : 'light'}
    />
  );

  if (compact) return <Box>{core}</Box>;

  return (
    <ConsolePanel title="Runtime Core" description="Live runtime orb — state, version, host, and last action">
      <Box sx={{ p: 2 }}>{core}</Box>
    </ConsolePanel>
  );
}
