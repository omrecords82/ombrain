import { Box, Stack, Typography, useTheme } from '@mui/material';
import { IconAlertTriangle, IconInfoCircle, IconPointFilled } from '@tabler/icons-react';

import type { BriefingChange } from '../briefingTypes';
import { ConsolePanel } from './ConsolePanel';

function formatWhen(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString();
}

export default function RecentChangesPanel({ changes }: { changes: BriefingChange[] }) {
  const theme = useTheme();

  return (
    <ConsolePanel title="What Changed Recently" description="State deltas and operator actions since the last check">
      {!changes.length ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No recent changes recorded yet.
        </Typography>
      ) : (
        <Box>
          {changes.map((c) => {
            const Icon = c.severity === 'critical' || c.severity === 'warning' ? IconAlertTriangle : c.severity === 'info' ? IconPointFilled : IconInfoCircle;
            const color =
              c.severity === 'critical'
                ? theme.palette.error.main
                : c.severity === 'warning'
                  ? theme.palette.warning.main
                  : theme.palette.text.secondary;
            return (
              <Stack
                key={c.id}
                direction="row"
                spacing={1.5}
                alignItems="flex-start"
                sx={{ px: 2, py: 1.1, borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
              >
                <Box sx={{ pt: 0.4 }}>
                  <Icon size={14} color={color} />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">{c.summary}</Typography>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {formatWhen(c.observed_at)}
                </Typography>
              </Stack>
            );
          })}
        </Box>
      )}
    </ConsolePanel>
  );
}