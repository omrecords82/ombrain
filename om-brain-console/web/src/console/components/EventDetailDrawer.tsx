import { Box, Chip, Drawer, IconButton, Stack, Typography } from '@mui/material';
import { IconX } from '@tabler/icons-react';

import type { EventDetail } from '../types';
import SafetyBadge from './SafetyBadge';

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  pending: 'info',
};

export default function EventDetailDrawer({
  detail,
  onClose,
}: {
  detail: EventDetail | null;
  onClose: () => void;
}) {
  return (
    <Drawer anchor="right" open={Boolean(detail)} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}>
      {detail && (
        <Box sx={{ p: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
            <Box>
              <Typography variant="overline" color="text.secondary">
                {detail.kind === 'activity' ? 'Console Activity' : 'Ledger Event'}
              </Typography>
              <Typography variant="h6" sx={{ wordBreak: 'break-word' }}>
                {detail.title}
              </Typography>
            </Box>
            <IconButton size="small" onClick={onClose} aria-label="Close">
              <IconX size={18} />
            </IconButton>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            {detail.status && (
              <Chip size="small" color={STATUS_COLOR[detail.status] ?? 'default'} label={detail.status} />
            )}
            {detail.safety && <SafetyBadge level={detail.safety} />}
          </Stack>

          <Stack spacing={1.5}>
            {detail.endpoint && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Endpoint
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {detail.endpoint}
                </Typography>
              </Box>
            )}
            {detail.actor && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Actor
                </Typography>
                <Typography variant="body2">{detail.actor}</Typography>
              </Box>
            )}
            <Box>
              <Typography variant="caption" color="text.secondary">
                Timestamp
              </Typography>
              <Typography variant="body2">{detail.timestamp}</Typography>
            </Box>
            {detail.latencyMs != null && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Latency
                </Typography>
                <Typography variant="body2">{detail.latencyMs} ms</Typography>
              </Box>
            )}
            {detail.extra?.map((e) => (
              <Box key={e.label}>
                <Typography variant="caption" color="text.secondary">
                  {e.label}
                </Typography>
                <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                  {e.value}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Drawer>
  );
}
