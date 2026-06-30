import { Box, Chip, Paper, Skeleton, Stack, Typography, alpha, useTheme } from '@mui/material';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconHelpCircle,
  IconHistory,
} from '@tabler/icons-react';

import type { BriefingModel, OverallState } from '../briefingTypes';

const STATE_CONFIG: Record<
  OverallState,
  { label: string; color: 'success' | 'warning' | 'error' | 'default'; icon: typeof IconCircleCheck }
> = {
  nominal: { label: 'Nominal', color: 'success', icon: IconCircleCheck },
  degraded: { label: 'Degraded', color: 'warning', icon: IconAlertTriangle },
  offline: { label: 'Offline', color: 'error', icon: IconCircleX },
  unknown: { label: 'Unknown', color: 'default', icon: IconHelpCircle },
};

function VerdictMetric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'error' }) {
  const theme = useTheme();
  const color = tone ? theme.palette[tone].main : theme.palette.text.primary;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography variant="subtitle1" sx={{ color, fontWeight: 700 }} noWrap>
        {value}
      </Typography>
    </Box>
  );
}

export default function BrainVerdictPanel({
  briefing,
  loading,
  error,
}: {
  briefing: BriefingModel | null;
  loading: boolean;
  error: string | null;
}) {
  const theme = useTheme();

  if (!briefing && loading) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Skeleton variant="text" width={280} height={36} />
        <Skeleton variant="text" width="80%" />
        <Skeleton variant="rectangular" height={56} sx={{ mt: 2, borderRadius: 2 }} />
      </Paper>
    );
  }

  if (!briefing) {
    return (
      <Paper variant="outlined" sx={{ p: 3, borderStyle: 'dashed' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <IconHelpCircle size={22} color={theme.palette.text.secondary} />
          <Box>
            <Typography variant="subtitle1">Briefing unavailable</Typography>
            <Typography variant="body2" color="text.secondary">
              {error || 'The operator briefing model could not be reached. Falling back to per-panel live checks below.'}
            </Typography>
          </Box>
        </Stack>
      </Paper>
    );
  }

  const cfg = STATE_CONFIG[briefing.overall_state] ?? STATE_CONFIG.unknown;
  const Icon = cfg.icon;
  const hv = briefing.health_verdict;
  const es = briefing.executive_summary;
  const accentColor =
    cfg.color === 'success'
      ? theme.palette.success.main
      : cfg.color === 'warning'
        ? theme.palette.warning.main
        : cfg.color === 'error'
          ? theme.palette.error.main
          : theme.palette.info.main;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 2.5, sm: 3 },
        borderColor: alpha(accentColor, 0.4),
        background: `linear-gradient(135deg, ${alpha(accentColor, 0.1)}, transparent)`,
      }}
    >
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2.5} justifyContent="space-between">
        <Stack direction="row" spacing={2} alignItems="flex-start" sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: alpha(accentColor, 0.16),
              color: accentColor,
            }}
          >
            <Icon size={28} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" color={cfg.color} label={cfg.label} sx={{ fontWeight: 700 }} />
              {es.operator_attention_required && (
                <Chip size="small" color="warning" variant="outlined" label="Attention required" />
              )}
              <Chip size="small" variant="outlined" label={`Confidence: ${es.confidence}`} />
            </Stack>
            <Typography variant="h5" sx={{ mt: 1, lineHeight: 1.3 }}>
              {es.headline}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              {es.explanation}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.25 }}>
              <IconHistory size={15} color={theme.palette.text.secondary} />
              <Typography variant="caption" color="text.secondary">
                {es.changed_since_last_check}
              </Typography>
            </Stack>
          </Box>
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'repeat(3, 1fr)', md: 'repeat(2, 1fr)' },
            gap: 2,
            minWidth: { md: 260 },
            borderLeft: { md: 1 },
            borderColor: 'divider',
            pl: { md: 3 },
          }}
        >
          <VerdictMetric label="Brain" value={hv.brain_online ? 'Online' : 'Offline'} tone={hv.brain_online ? 'success' : 'error'} />
          <VerdictMetric label="LLM circuit" value={hv.llm_available ? 'Available' : 'Degraded'} tone={hv.llm_available ? 'success' : 'warning'} />
          <VerdictMetric label="Governance" value={hv.governance_mode} />
          <VerdictMetric label="Skills" value={hv.skills_registered != null ? String(hv.skills_registered) : '—'} />
          <VerdictMetric
            label="Latency"
            value={hv.last_action_latency_ms != null ? `${hv.last_action_latency_ms} ms` : '—'}
          />
          <VerdictMetric label="Generated" value={new Date(briefing.generated_at).toLocaleTimeString()} />
        </Box>
      </Stack>
    </Paper>
  );
}
