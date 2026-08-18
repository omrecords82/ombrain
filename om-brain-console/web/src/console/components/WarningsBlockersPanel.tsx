import { Box, Chip, Stack, Typography, alpha, useTheme } from '@mui/material';
import {
  IconBan,
  IconClipboardX,
  IconEyeOff,
  IconQuestionMark,
  IconShieldLock,
  IconSettingsExclamation,
  IconPlayerPause,
} from '@tabler/icons-react';

import { BLOCKERS } from '../capabilities';
import type { BlockerCategory } from '../types';
import { ConsolePanel } from './ConsolePanel';

const CATEGORY_ICON: Record<BlockerCategory, typeof IconBan> = {
  blocked: IconBan,
  'not-built': IconClipboardX,
  'config-missing': IconSettingsExclamation,
  'security-boundary': IconShieldLock,
  'monitoring-unavailable': IconEyeOff,
  unknown: IconQuestionMark,
  'intentionally-disabled': IconPlayerPause,
};

const CATEGORY_LABEL: Record<BlockerCategory, string> = {
  blocked: 'Blocked',
  'not-built': 'Not implemented',
  'config-missing': 'Config missing',
  'security-boundary': 'Security boundary',
  'monitoring-unavailable': 'Monitoring unavailable',
  unknown: 'Unknown',
  'intentionally-disabled': 'Intentionally disabled',
};

const SEVERITY_COLOR: Record<'critical' | 'warning' | 'info', 'error' | 'warning' | 'info'> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};

export default function WarningsBlockersPanel() {
  const theme = useTheme();

  return (
    <ConsolePanel
      title="Warnings & Blocked Capabilities"
      description="Capability gaps classified by cause — missing config, unimplemented, disabled, unknown, or intentional security boundaries. Absence of monitoring is never treated as healthy."
    >
      <Box>
        {BLOCKERS.map((b) => {
          const Icon = CATEGORY_ICON[b.category] || IconQuestionMark;
          return (
            <Stack
              key={b.id}
              direction="row"
              spacing={1.5}
              alignItems="flex-start"
              sx={{ p: 1.75, borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
            >
              <Box
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: 1.5,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: alpha(theme.palette[SEVERITY_COLOR[b.severity]].main, 0.15),
                  color: theme.palette[SEVERITY_COLOR[b.severity]].main,
                }}
              >
                <Icon size={16} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="body2" fontWeight={600}>
                    {b.name}
                  </Typography>
                  <Chip size="small" variant="outlined" label={CATEGORY_LABEL[b.category] || b.category} />
                  <Chip size="small" color={SEVERITY_COLOR[b.severity]} variant="outlined" label={b.severity} />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {b.impact}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.4 }}>
                  Fix: {b.requiredFix} · Owner: {b.owner}
                </Typography>
              </Box>
            </Stack>
          );
        })}
      </Box>
    </ConsolePanel>
  );
}
