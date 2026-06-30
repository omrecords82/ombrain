import { Box, Button, Chip, Paper, Stack, Typography, alpha, useTheme } from '@mui/material';
import { IconChevronRight } from '@tabler/icons-react';

import type { CapabilityDetail } from '../types';
import SafetyBadge from './SafetyBadge';

const STATE_COLOR: Record<CapabilityDetail['state'], 'success' | 'warning' | 'default' | 'error'> = {
  available: 'success',
  partial: 'warning',
  pending: 'default',
  blocked: 'error',
};

const STATE_LABEL: Record<CapabilityDetail['state'], string> = {
  available: 'Available',
  partial: 'Partial',
  pending: 'Pending',
  blocked: 'Blocked',
};

export default function CapabilityCard({
  detail,
  onOpenDetail,
  onQuickAction,
}: {
  detail: CapabilityDetail;
  onOpenDetail: (detail: CapabilityDetail) => void;
  onQuickAction?: (detail: CapabilityDetail) => void;
}) {
  const theme = useTheme();
  const stateColor = STATE_COLOR[detail.state];

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.75,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        cursor: 'pointer',
        transition: 'border-color 0.15s, transform 0.1s',
        '&:hover': { borderColor: alpha(theme.palette.primary.main, 0.5) },
      }}
      onClick={() => onOpenDetail(detail)}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Typography variant="subtitle2" sx={{ lineHeight: 1.3 }}>
          {detail.capability}
        </Typography>
        <Chip size="small" color={stateColor} label={STATE_LABEL[detail.state]} />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
        {detail.note}
      </Typography>

      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
        <SafetyBadge level={detail.safety} />
        <Chip size="small" variant="outlined" label={detail.gate} />
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Last verified: {detail.lastVerified}
      </Typography>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 'auto', pt: 0.5 }}>
        {detail.navigateTo && onQuickAction ? (
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onQuickAction(detail);
            }}
          >
            Open
          </Button>
        ) : (
          <Box />
        )}
        <Stack direction="row" alignItems="center" spacing={0.25} sx={{ color: 'text.secondary' }}>
          <Typography variant="caption">Details</Typography>
          <IconChevronRight size={14} />
        </Stack>
      </Stack>
    </Paper>
  );
}
