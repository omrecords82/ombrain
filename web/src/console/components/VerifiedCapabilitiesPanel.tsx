import { Box, Chip, Stack, Typography } from '@mui/material';

import { VERIFIED_CAPABILITIES } from '../capabilities';
import { ConsolePanel } from './ConsolePanel';

export default function VerifiedCapabilitiesPanel() {
  return (
    <ConsolePanel title="Verified Capabilities Today" description="Structured, grouped — not a raw bullet list">
      <Box sx={{ p: 2 }}>
        {VERIFIED_CAPABILITIES.map((group) => (
          <Box key={group.group} sx={{ mb: 2, '&:last-child': { mb: 0 } }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
              {group.group}
            </Typography>
            <Stack spacing={0.75}>
              {group.items.map((item) => (
                <Stack
                  key={item.id}
                  direction="row"
                  justifyContent="space-between"
                  alignItems="flex-start"
                  spacing={1}
                  sx={{ px: 1.25, py: 0.85, borderRadius: 1, bgcolor: 'action.hover' }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600} noWrap>
                      {item.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                      {item.source}
                    </Typography>
                  </Box>
                  <Chip size="small" variant="outlined" label={item.lastVerified} sx={{ flexShrink: 0 }} />
                </Stack>
              ))}
            </Stack>
          </Box>
        ))}
      </Box>
    </ConsolePanel>
  );
}
