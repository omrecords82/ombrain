import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { IconAlertTriangle, IconCircleCheck, IconRefresh } from '@tabler/icons-react';

import { brainRootPost } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import CapabilityRunnerCard from '../components/CapabilityRunnerCard';
import { ConsolePanel, PageHeading } from '../components/ConsolePanel';
import type { DiagnosticItem } from '../types';

export default function DiagnosticsScreen() {
  const theme = useTheme();
  const { proxyHealth, brainHealth, healthError, refreshHealth, healthLoading, runBrainCall } = useBrainConsole();
  const [incidentJson, setIncidentJson] = useState('{"summary":"test connectivity"}');
  const [lastRun, setLastRun] = useState<string | null>(null);

  const diagnostics = useMemo((): DiagnosticItem[] => {
    return [
      {
        id: 'proxy',
        name: 'OMAI Brain Proxy',
        description: 'OMAI /api/brain/* → om-dev upstream',
        state: proxyHealth?.ok ? 'operational' : proxyHealth ? 'down' : 'pending',
        lastCheck: lastRun ?? '—',
        recommendedAction: proxyHealth?.ok ? 'No action needed' : 'Check OMAI brain proxy service on :7060',
        severity: proxyHealth?.ok ? 'info' : 'critical',
      },
      {
        id: 'upstream',
        name: 'om-brain upstream',
        description: 'Governance health / skills probe',
        state: brainHealth?.ok !== false ? 'operational' : 'down',
        lastCheck: lastRun ?? '—',
        recommendedAction: brainHealth ? 'Upstream reachable' : 'Verify om-brain on om-dev .254:8390',
        severity: brainHealth?.ok !== false ? 'info' : 'critical',
      },
      {
        id: 'places',
        name: 'Google Places',
        description: 'Church finder live search',
        state: proxyHealth?.google_places_configured ? 'operational' : 'degraded',
        lastCheck: lastRun ?? '—',
        recommendedAction: proxyHealth?.google_places_configured
          ? 'Configured'
          : 'Set GOOGLE_PLACES_API_KEY in OMStudio secrets',
        severity: proxyHealth?.google_places_configured ? 'info' : 'warning',
      },
      {
        id: 'llm',
        name: 'LLM circuit',
        description: brainHealth?.llm?.model
          ? `${brainHealth.llm.provider || 'LLM'} · ${brainHealth.llm.model}`
          : 'Local inference gateway posture',
        state:
          brainHealth?.llm?.status === 'available' || brainHealth?.llm_endpoint_allowed === true
            ? 'operational'
            : brainHealth?.llm?.status === 'degraded' || brainHealth?.llm?.status === 'disabled' || brainHealth?.llm_endpoint_allowed === false
              ? 'degraded'
              : brainHealth?.llm?.status === 'error'
                ? 'down'
                : 'pending',
        lastCheck: lastRun ?? '—',
        recommendedAction:
          brainHealth?.llm?.last_error
            ? String(brainHealth.llm.last_error)
            : brainHealth?.llm?.status === 'not_configured'
              ? 'Configure BRAIN_LLM_BASE_URL on om-dev'
              : 'Monitor circuit breaker',
        severity:
          brainHealth?.llm?.status === 'error'
            ? 'critical'
            : brainHealth?.llm?.status === 'disabled' || brainHealth?.llm?.status === 'degraded'
              ? 'warning'
              : 'info',
      },
    ];
  }, [brainHealth, lastRun, proxyHealth]);

  const counts = {
    operational: diagnostics.filter((d) => d.state === 'operational').length,
    degraded: diagnostics.filter((d) => d.state === 'degraded').length,
    down: diagnostics.filter((d) => d.state === 'down').length,
  };

  const runSuite = async () => {
    await refreshHealth({ manual: true });
    setLastRun(new Date().toISOString().slice(11, 19));
  };

  const stateIcon = (state: DiagnosticItem['state']) => {
    if (state === 'operational') return <IconCircleCheck size={18} color={theme.palette.success.main} />;
    return <IconAlertTriangle size={18} color={theme.palette.warning.main} />;
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Diagnostics"
        description="Bounded, read-only operator checks. Diagnostics probe subsystems without mutating state."
        actions={
          <Button
            variant="contained"
            size="small"
            startIcon={healthLoading ? <CircularProgress size={14} color="inherit" /> : <IconRefresh size={16} />}
            onClick={runSuite}
            disabled={healthLoading}
          >
            {healthLoading ? 'Running suite…' : 'Run diagnostic suite'}
          </Button>
        }
      />

      <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
        <Stack direction="row" flexWrap="wrap" spacing={2} useFlexGap>
          <Typography variant="body2" color="text.secondary">
            Last full run: <strong>{lastRun ?? 'not yet'}</strong>
          </Typography>
          <Typography variant="body2">{counts.operational} operational</Typography>
          <Typography variant="body2">{counts.degraded} degraded</Typography>
          <Typography variant="body2">{counts.down} down</Typography>
        </Stack>
      </Paper>

      {healthError && <Alert severity="warning">{healthError}</Alert>}

      <Grid container spacing={2}>
        {diagnostics.map((d) => (
          <Grid key={d.id} size={{ xs: 12, md: 6 }}>
            <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                {stateIcon(d.state)}
                <Box>
                  <Typography variant="subtitle2">{d.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {d.description}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                    {d.recommendedAction}
                  </Typography>
                </Box>
              </Stack>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <ConsolePanel title="Incident diagnose" description="POST /diagnose (use_model: false)">
        <Stack spacing={2} sx={{ p: 2 }}>
          <TextField
            fullWidth
            multiline
            minRows={4}
            label="Incident JSON"
            value={incidentJson}
            onChange={(e) => setIncidentJson(e.target.value)}
          />
          <CapabilityRunnerCard
            title="Diagnose incident"
            description="Structured incident analysis without LLM (use_model: false)."
            safety="diagnostic"
            actionLabel="POST /diagnose"
            controls={<Box />}
            onRun={async () => {
              let incident: Record<string, unknown> = { summary: 'test' };
              try {
                incident = JSON.parse(incidentJson);
              } catch {
                throw new Error('Incident JSON is invalid');
              }
              const { result } = await runBrainCall({
                endpoint: 'POST /api/brain/diagnose',
                action: 'Diagnose incident',
                safety: 'diagnostic',
                call: () => brainRootPost('/diagnose', { incident, use_model: false }),
              });
              return result;
            }}
          />
        </Stack>
      </ConsolePanel>
    </Stack>
  );
}
