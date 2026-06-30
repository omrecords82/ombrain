import { Box, Chip, Stack, Typography } from '@mui/material';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
} from '@tabler/icons-react';

import type { ActivityRow } from '../types';
import SafetyBadge from './SafetyBadge';

const statusIcon = {
  success: IconCircleCheck,
  error: IconCircleX,
  pending: IconLoader2,
  warning: IconAlertTriangle,
} as const;

const statusColor = {
  success: 'success.main',
  error: 'error.main',
  pending: 'info.main',
  warning: 'warning.main',
} as const;

export default function RecentActivity({
  rows,
  limit,
}: {
  rows: ActivityRow[];
  limit?: number;
}) {
  const visible = limit ? rows.slice(0, limit) : rows;

  if (!visible.length) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          No brain proxy activity recorded yet. Health checks and API calls appear here after the first request.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ divideY: 1 }}>
      {visible.map((row) => {
        const Icon = statusIcon[row.status];
        return (
          <Stack
            key={row.id}
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{
              px: 2,
              py: 1.25,
              borderBottom: 1,
              borderColor: 'divider',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Icon size={18} color={statusColor[row.status]} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={500} noWrap>
                {row.action}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }} noWrap display="block">
                {row.endpoint}
              </Typography>
            </Box>
            <Box sx={{ display: { xs: 'none', md: 'block' } }}>
              <SafetyBadge level={row.safety} />
            </Box>
            <Box sx={{ display: { xs: 'none', sm: 'block' }, textAlign: 'right', minWidth: 72 }}>
              <Typography variant="body2">{row.latencyMs} ms</Typography>
              <Typography variant="caption" color="text.secondary">
                {row.session}
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56, textAlign: 'right' }}>
              {row.timestamp}
            </Typography>
          </Stack>
        );
      })}
    </Box>
  );
}

export function ActivityStatusChip({ status }: { status: ActivityRow['status'] }) {
  const color = status === 'success' ? 'success' : status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info';
  return <Chip size="small" color={color} label={status} />;
}
