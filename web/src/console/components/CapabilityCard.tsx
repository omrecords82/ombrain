import { useState, type ReactNode } from 'react';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { IconClock } from '@tabler/icons-react';

import type { ResultData, SafetyLevel } from '../types';
import ResultPanel from './ResultPanel';
import SafetyBadge from './SafetyBadge';

export interface CapabilityCardProps {
  title: string;
  description: string;
  safety: SafetyLevel;
  stateBadge?: { label: string; tone: 'available' | 'partial' | 'pending' };
  controls: ReactNode;
  actionLabel: string;
  disabled?: boolean;
  onRun: () => Promise<ResultData> | ResultData;
}

const stateColors = {
  available: { color: 'success.main', border: 'success.light' },
  partial: { color: 'warning.main', border: 'warning.light' },
  pending: { color: 'text.secondary', border: 'divider' },
};

export default function CapabilityCard({
  title,
  description,
  safety,
  stateBadge,
  controls,
  actionLabel,
  disabled,
  onRun,
}: CapabilityCardProps) {
  const [result, setResult] = useState<ResultData | null>(null);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<string | undefined>();

  const run = async () => {
    setRunning(true);
    try {
      const r = await onRun();
      setResult(r);
      setRan('just now');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', height: '100%' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Typography variant="subtitle1">{title}</Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap justifyContent="flex-end">
            {stateBadge && (
              <Typography
                variant="caption"
                sx={{
                  px: 1,
                  py: 0.25,
                  borderRadius: 1,
                  border: 1,
                  borderColor: stateColors[stateBadge.tone].border,
                  color: stateColors[stateBadge.tone].color,
                  fontWeight: 600,
                }}
              >
                {stateBadge.label}
              </Typography>
            )}
            <SafetyBadge level={safety} />
          </Stack>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {description}
        </Typography>
      </Box>

      <Stack spacing={2} sx={{ p: 2 }}>
        {controls}
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Button variant="contained" size="small" onClick={run} disabled={disabled || running}>
            {running ? 'Running…' : actionLabel}
          </Button>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <IconClock size={14} />
            <Typography variant="caption" color="text.secondary">
              {ran ? `Last run: ${ran}` : 'Not run yet'}
            </Typography>
          </Stack>
        </Stack>
        <ResultPanel result={result} emptyHint="Output preview will appear here after running." />
      </Stack>
    </Paper>
  );
}
