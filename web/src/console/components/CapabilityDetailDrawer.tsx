import { Box, Button, Chip, Drawer, IconButton, Stack, Typography } from '@mui/material';
import { IconX } from '@tabler/icons-react';

import type { CapabilityDetail, SectionId } from '../types';
import SafetyBadge from './SafetyBadge';

const STATE_COLOR: Record<CapabilityDetail['state'], 'success' | 'warning' | 'default' | 'error'> = {
  available: 'success',
  partial: 'warning',
  pending: 'default',
  blocked: 'error',
};

export default function CapabilityDetailDrawer({
  detail,
  onClose,
  onNavigate,
}: {
  detail: CapabilityDetail | null;
  onClose: () => void;
  onNavigate: (id: SectionId) => void;
}) {
  return (
    <Drawer anchor="right" open={Boolean(detail)} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}>
      {detail && (
        <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
            <Box>
              <Typography variant="overline" color="text.secondary">
                {detail.category}
              </Typography>
              <Typography variant="h6">{detail.capability}</Typography>
            </Box>
            <IconButton size="small" onClick={onClose} aria-label="Close">
              <IconX size={18} />
            </IconButton>
          </Stack>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <Chip size="small" color={STATE_COLOR[detail.state]} label={detail.state} />
            <Chip size="small" variant="outlined" label={detail.gate} />
            <SafetyBadge level={detail.safety} />
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {detail.note}
          </Typography>

          <Box sx={{ mb: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Last verified
            </Typography>
            <Typography variant="body2" fontWeight={600}>
              {detail.lastVerified}
            </Typography>
          </Box>

          {detail.endpoint && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Endpoint
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {detail.endpoint}
              </Typography>
            </Box>
          )}

          {detail.detailBullets && detail.detailBullets.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                Notes
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {detail.detailBullets.map((b) => (
                  <Typography key={b} component="li" variant="body2" sx={{ mb: 0.5 }}>
                    {b}
                  </Typography>
                ))}
              </Box>
            </Box>
          )}

          <Box sx={{ mt: 'auto', pt: 2 }}>
            {detail.navigateTo && (
              <Button
                fullWidth
                variant="contained"
                onClick={() => {
                  onNavigate(detail.navigateTo as SectionId);
                  onClose();
                }}
              >
                Open workspace
              </Button>
            )}
          </Box>
        </Box>
      )}
    </Drawer>
  );
}
