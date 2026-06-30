import { Alert, Box, Button, Chip, Grid, Stack, Typography } from '@mui/material';
import {
  IconAlertTriangle,
  IconBolt,
  IconBox,
  IconChevronRight,
  IconMessage,
  IconSchool,
  IconShieldCheck,
  IconStethoscope,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';

import {
  listOmaiProxyActivity,
  type BrainActivityRecord,
} from '../../api/brainApi';
import { useBrainConsole } from '../BrainConsoleContext';
import { CAPABILITIES, capabilityMatrix } from '../capabilities';
import { ConsolePanel } from '../components/ConsolePanel';
import RecentActivity from '../components/RecentActivity';
import RuntimeCore from '../components/RuntimeCore';
import SafetyBadge from '../components/SafetyBadge';
import type { ActivityRow, SectionId } from '../types';

const stateColors = {
  available: 'success',
  partial: 'warning',
  pending: 'default',
  blocked: 'error',
} as const;

const stateLabel = {
  available: 'Available',
  partial: 'Partial',
  pending: 'Pending',
  blocked: 'Blocked',
} as const;

const quickActions = [
  { id: 'ask' as SectionId, label: 'Ask Brain', icon: IconMessage },
  { id: 'actions' as SectionId, label: 'Actions', icon: IconBolt },
  { id: 'teach' as SectionId, label: 'Teach Skill', icon: IconSchool },
  { id: 'skills' as SectionId, label: 'View Skills', icon: IconBox },
  { id: 'diagnostics' as SectionId, label: 'Run Diagnostic', icon: IconStethoscope },
  { id: 'governance' as SectionId, label: 'Open Governance', icon: IconShieldCheck },
];

function mapOmaiActivity(row: BrainActivityRecord): ActivityRow {
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
    session: row.user_role || 'omai',
    safety: row.governance === 'diagnostic' ? 'diagnostic' : 'read-only',
  };
}

export default function OverviewScreen({ onNavigate }: { onNavigate: (id: SectionId) => void }) {
  const { proxyHealth, brainHealth, healthError, activity } = useBrainConsole();
  const [omaiActivity, setOmaiActivity] = useState<ActivityRow[]>([]);
  const [omaiUnavailable, setOmaiUnavailable] = useState(false);

  const loadOmaiActivity = useCallback(async () => {
    try {
      const data = await listOmaiProxyActivity(10);
      if (data.unavailable || data.ok === false) {
        setOmaiUnavailable(true);
        setOmaiActivity([]);
        return;
      }
      setOmaiUnavailable(false);
      setOmaiActivity((data.activity || []).map(mapOmaiActivity));
    } catch {
      setOmaiUnavailable(true);
      setOmaiActivity([]);
    }
  }, []);

  useEffect(() => {
    void loadOmaiActivity();
  }, [loadOmaiActivity]);

  const consoleOk = proxyHealth?.ok === true;
  const upstreamOk = brainHealth != null && brainHealth.ok !== false;
  const warnings: string[] = [];
  if (healthError) warnings.push(healthError);
  if (brainHealth?.llm?.status === 'disabled' || brainHealth?.llm_endpoint_allowed === false) {
    warnings.push('LLM circuit disabled or blocked on om-dev.');
  }
  if (brainHealth?.llm?.status === 'not_configured') {
    warnings.push('LLM endpoint not configured on om-brain.');
  }

  return (
    <Stack spacing={3}>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
        {quickActions.map((a, idx) => {
          const Icon = a.icon;
          return (
            <Button
              key={`${a.id}-${idx}`}
              variant="outlined"
              size="small"
              startIcon={<Icon size={16} />}
              onClick={() => onNavigate(a.id)}
            >
              {a.label}
            </Button>
          );
        })}
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, xl: 8 }}>
          <Stack spacing={2}>
            <ConsolePanel title="Runtime health summary" description="Live posture across OMBrain subsystems">
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
                }}
              >
                {[
                  { label: 'Console', value: consoleOk ? 'Online' : 'Offline', color: consoleOk ? 'success.main' : 'error.main' },
                  { label: 'om-brain', value: upstreamOk ? 'Reachable' : 'Unreachable', color: upstreamOk ? 'success.main' : 'warning.main' },
                  { label: 'Open warnings', value: String(warnings.length), color: warnings.length ? 'warning.main' : 'success.main' },
                  { label: 'Governance', value: brainHealth?.executes_actions ? 'Executes' : 'Auditor', color: 'info.main' },
                ].map((m) => (
                  <Box key={m.label} sx={{ p: 2, borderRight: 1, borderColor: 'divider', '&:last-child': { borderRight: 0 } }}>
                    <Typography variant="caption" color="text.secondary">
                      {m.label}
                    </Typography>
                    <Typography variant="h6" sx={{ color: m.color }}>
                      {m.value}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </ConsolePanel>

            {healthError && <Alert severity="warning">{healthError}</Alert>}

            <ConsolePanel
              title="Recent Console Activity"
              description="Latest calls through the local om-brain-console proxy on om-dev"
              action={
                <Button size="small" endIcon={<IconChevronRight size={14} />} onClick={() => onNavigate('events')}>
                  Event ledger
                </Button>
              }
            >
              <RecentActivity rows={activity} limit={5} />
            </ConsolePanel>

            <ConsolePanel
              title="OMAI Proxy Activity (optional)"
              description="Historical calls via OMAI on .239 — shown when OMAI is reachable; does not affect Brain health"
            >
              {omaiUnavailable ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  OMAI proxy activity unavailable
                </Typography>
              ) : (
                <RecentActivity rows={omaiActivity} limit={5} />
              )}
            </ConsolePanel>

            <ConsolePanel
              title="Capability availability matrix"
              description="What OMBrain can do right now, and how it's gated"
            >
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                {capabilityMatrix.map((c) => (
                  <Stack
                    key={c.id}
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    spacing={1}
                    sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={600} noWrap>
                        {c.capability}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap display="block">
                        {c.note}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexShrink={0}>
                      <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
                        <SafetyBadge level={c.safety} />
                      </Box>
                      <Chip size="small" color={stateColors[c.state]} label={stateLabel[c.state]} />
                    </Stack>
                  </Stack>
                ))}
              </Box>
            </ConsolePanel>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, xl: 4 }}>
          <Stack spacing={2}>
            <RuntimeCore />

            <ConsolePanel title="Works today" description="Verified live capabilities">
              <Box component="ul" sx={{ m: 0, pl: 2.5, p: 2 }}>
                {CAPABILITIES.working.map((item) => (
                  <Typography key={item} component="li" variant="body2" sx={{ mb: 0.5 }}>
                    {item}
                  </Typography>
                ))}
              </Box>
            </ConsolePanel>

            <ConsolePanel title="Recent errors & warnings" description="Subsystems needing attention">
              {warnings.length ? (
                warnings.map((w) => (
                  <Stack key={w} direction="row" spacing={1.5} sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
                    <IconAlertTriangle size={18} color="orange" />
                    <Typography variant="body2">{w}</Typography>
                  </Stack>
                ))
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                  No warnings — console and om-brain look healthy.
                </Typography>
              )}
            </ConsolePanel>

            <ConsolePanel title="Blocked or not built">
              <Box component="ul" sx={{ m: 0, pl: 2.5, p: 2 }}>
                {CAPABILITIES.blocked.map((item) => (
                  <Typography key={item} component="li" variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                    {item}
                  </Typography>
                ))}
              </Box>
            </ConsolePanel>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
