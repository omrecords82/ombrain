import { useState } from 'react';
import { Box, Button, Chip, Collapse, Stack, Typography, alpha, useTheme } from '@mui/material';
import { IconAlertTriangle, IconChevronDown, IconEyeOff } from '@tabler/icons-react';

import type { BriefingEventCluster, BriefingSuppressedNoise, EventClassification } from '../briefingTypes';
import { ConsolePanel } from './ConsolePanel';

const CLASSIFICATION_LABEL: Record<EventClassification, string> = {
  signal: 'Signal',
  expected_noise: 'Expected noise',
  duplicate: 'Duplicate',
  low_value_audit: 'Low-value audit',
  requires_attention: 'Requires attention',
};

const CLASSIFICATION_COLOR: Record<EventClassification, 'success' | 'warning' | 'error' | 'default' | 'info'> = {
  signal: 'info',
  expected_noise: 'default',
  duplicate: 'default',
  low_value_audit: 'default',
  requires_attention: 'error',
};

function TargetDetailLine({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      {label}: <Box component="span" sx={{ fontFamily: 'monospace' }}>{value}</Box>
    </Typography>
  );
}

function ClusterRow({ cluster }: { cluster: BriefingEventCluster }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const attention = cluster.classification_summary === 'requires_attention';
  const target = cluster.target;
  const malformed = Boolean(cluster.malformed_telemetry);

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}>
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="flex-start"
        sx={{ p: 1.75, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
        onClick={() => setOpen((v) => !v)}
      >
        {attention && (
          <Box sx={{ pt: 0.3 }}>
            <IconAlertTriangle size={16} color={theme.palette.error.main} />
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" fontWeight={600}>
              {cluster.title}
            </Typography>
            <Chip size="small" label={`×${cluster.count}`} variant="outlined" />
            {cluster.event_type && (
              <Chip size="small" variant="outlined" label={`Type: ${cluster.event_type}`} sx={{ fontFamily: 'monospace' }} />
            )}
            {malformed && <Chip size="small" color="warning" variant="filled" label="Malformed telemetry" />}
            <Chip
              size="small"
              color={CLASSIFICATION_COLOR[cluster.classification_summary]}
              variant={attention ? 'filled' : 'outlined'}
              label={CLASSIFICATION_LABEL[cluster.classification_summary]}
            />
            <Chip size="small" variant="outlined" label={`confidence: ${cluster.confidence}`} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {cluster.impact}
          </Typography>
          <Collapse in={open}>
            <Box sx={{ mt: 1, p: 1.25, borderRadius: 1, bgcolor: alpha(theme.palette.text.primary, 0.04) }}>
              {target && (
                <Box sx={{ mb: 0.75 }}>
                  <TargetDetailLine label="Type" value={cluster.event_type} />
                  <TargetDetailLine label="Target" value={target.target_name} />
                  <TargetDetailLine label="Target IP" value={target.target_ip} />
                  <TargetDetailLine label="Target host" value={target.target_host} />
                  <TargetDetailLine label="Source" value={target.source_component} />
                  <TargetDetailLine label="Checked from" value={target.checked_from} />
                  <TargetDetailLine label="Method" value={target.check_method} />
                  <TargetDetailLine label="Endpoint" value={target.check_endpoint} />
                  <TargetDetailLine label="Port" value={target.target_port} />
                  <TargetDetailLine label="Last failure" value={target.last_failure_at} />
                  <TargetDetailLine label="Last success" value={target.last_success_at} />
                </Box>
              )}
              <Typography variant="caption" color="text.secondary" display="block">
                Likely cause: {cluster.likely_cause}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                First seen {cluster.first_seen} · Last seen {cluster.last_seen}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 600 }}>
                Recommended: {cluster.recommended_action}
              </Typography>
            </Box>
          </Collapse>
        </Box>
        <IconChevronDown
          size={16}
          style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', flexShrink: 0, marginTop: 4 }}
        />
      </Stack>
    </Box>
  );
}

export default function EventClustersPanel({
  clusters,
  suppressedNoise,
  limit,
  onOpenRaw,
}: {
  clusters: BriefingEventCluster[];
  suppressedNoise: BriefingSuppressedNoise[];
  limit?: number;
  onOpenRaw?: () => void;
}) {
  const visible = limit ? clusters.slice(0, limit) : clusters;
  const suppressedCount = suppressedNoise.reduce((acc, s) => acc + s.count, 0);

  return (
    <ConsolePanel
      title="Event Clusters"
      description="Repeated event rows grouped by event type, target host/IP, source component, and check method"
      action={
        onOpenRaw ? (
          <Button size="small" onClick={onOpenRaw}>
            View raw events
          </Button>
        ) : undefined
      }
    >
      {!visible.length ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No event clusters yet — the event ledger may be empty or unavailable.
        </Typography>
      ) : (
        <Box>
          {visible.map((c) => (
            <ClusterRow key={c.id} cluster={c} />
          ))}
        </Box>
      )}
      {suppressedCount > 0 && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}
        >
          <IconEyeOff size={15} />
          <Typography variant="caption" color="text.secondary">
            {suppressedCount} noisy/duplicate/low-value events suppressed from this view ({suppressedNoise.length} patterns) — see Event Ledger for the full breakdown.
          </Typography>
        </Stack>
      )}
    </ConsolePanel>
  );
}
