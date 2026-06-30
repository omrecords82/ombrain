import { Box, Paper, Stack, Typography, alpha, useTheme } from '@mui/material';
import {
  IconActivity,
  IconBox,
  IconGauge,
  IconNetwork,
  IconShieldCheck,
} from '@tabler/icons-react';

import type { StatusCardData } from '../types';

const icons = {
  activity: IconActivity,
  boxes: IconBox,
  network: IconNetwork,
  shield: IconShieldCheck,
  gauge: IconGauge,
};

const tonePaletteKey = {
  success: 'success',
  warning: 'warning',
  danger: 'error',
  info: 'info',
  neutral: 'grey',
} as const;

export default function StatusCard({ data }: { data: StatusCardData }) {
  const theme = useTheme();
  const Icon = icons[data.icon];
  const paletteKey = tonePaletteKey[data.tone];
  const mainColor =
    paletteKey === 'grey'
      ? theme.palette.text.secondary
      : theme.palette[paletteKey].main;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        height: '100%',
      }}
    >
      <Box
        sx={{
          width: 36,
          height: 36,
          borderRadius: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          bgcolor: alpha(mainColor, 0.12),
          color: mainColor,
        }}
      >
        <Icon size={18} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: mainColor, flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary" noWrap>
            {data.label}
          </Typography>
        </Stack>
        <Typography variant="h6" sx={{ lineHeight: 1.2, mt: 0.25 }} noWrap>
          {data.value}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {data.meta}
        </Typography>
      </Box>
    </Paper>
  );
}
