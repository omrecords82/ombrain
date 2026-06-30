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

function StripCard({ data }: { data: StatusCardData }) {
  const theme = useTheme();
  const Icon = icons[data.icon];
  const paletteKey = tonePaletteKey[data.tone];
  const mainColor = paletteKey === 'grey' ? theme.palette.text.secondary : theme.palette[paletteKey].main;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.75,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        height: '100%',
        borderColor: data.tone === 'danger' || data.tone === 'warning' ? alpha(mainColor, 0.45) : undefined,
        transition: 'border-color 0.2s, transform 0.15s',
        '&:hover': { borderColor: alpha(mainColor, 0.6) },
      }}
    >
      <Box
        sx={{
          width: 38,
          height: 38,
          borderRadius: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          bgcolor: alpha(mainColor, 0.14),
          color: mainColor,
        }}
      >
        <Icon size={19} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: mainColor, flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary" fontWeight={600} noWrap>
            {data.label}
          </Typography>
        </Stack>
        <Typography variant="h6" sx={{ lineHeight: 1.25, mt: 0.25, color: mainColor }} noWrap>
          {data.value}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {data.meta}
        </Typography>
      </Box>
    </Paper>
  );
}

export default function BrainStatusStrip({ cards }: { cards: StatusCardData[] }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr 1fr',
          sm: 'repeat(3, 1fr)',
          lg: 'repeat(6, 1fr)',
        },
        gap: 1.5,
      }}
    >
      {cards.map((c) => (
        <StripCard key={c.id} data={c} />
      ))}
    </Box>
  );
}
