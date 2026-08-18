import { Box, Button, Chip, Paper, Stack, Typography, alpha, useTheme } from '@mui/material';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';

import type { ActionQueueItem, ActionQueueSeverity, SectionId } from '../types';
import { ConsolePanel } from './ConsolePanel';

const SEVERITY_CONFIG: Record<
  ActionQueueSeverity,
  { label: string; color: 'error' | 'warning' | 'info'; icon: typeof IconAlertTriangle }
> = {
  critical: { label: 'Critical', color: 'error', icon: IconAlertTriangle },
  warning: { label: 'Warning', color: 'warning', icon: IconAlertTriangle },
  info: { label: 'Informational', color: 'info', icon: IconInfoCircle },
};

function QueueRow({ item, onNavigate }: { item: ActionQueueItem; onNavigate?: (id: SectionId) => void }) {
  const theme = useTheme();
  const cfg = SEVERITY_CONFIG[item.severity];
  const Icon = cfg.icon;

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.5}
      alignItems={{ sm: 'flex-start' }}
      sx={{
        p: 2,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-child': { borderBottom: 0 },
      }}
    >
      <Box
        sx={{
          width: 34,
          height: 34,
          borderRadius: 1.5,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: alpha(theme.palette[cfg.color].main, 0.15),
          color: theme.palette[cfg.color].main,
        }}
      >
        <Icon size={18} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2">{item.title}</Typography>
          <Chip size="small" color={cfg.color} variant="outlined" label={cfg.label} />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {item.explanation}
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 600 }}>
          Recommended: {item.recommendedAction}
        </Typography>
      </Box>
      {item.navigateTo && item.buttonLabel && (
        <Button
          size="small"
          variant="outlined"
          color={cfg.color === 'info' ? 'primary' : cfg.color}
          onClick={() => onNavigate?.(item.navigateTo as SectionId)}
          sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
        >
          {item.buttonLabel}
        </Button>
      )}
    </Stack>
  );
}

export default function OperatorActionQueue({
  items,
  onNavigate,
  description,
}: {
  items: ActionQueueItem[];
  onNavigate?: (id: SectionId) => void;
  description?: string;
}) {
  const critical = items.filter((i) => i.severity === 'critical');
  const warning = items.filter((i) => i.severity === 'warning');
  const info = items.filter((i) => i.severity === 'info');

  const allClear = critical.length === 0 && warning.length === 0;

  return (
    <ConsolePanel
      title="Operator Action Queue"
      description={description ?? 'What needs attention right now, and what to do about it'}
      action={
        allClear ? (
          <Chip size="small" color="success" icon={<IconCircleCheck size={14} />} label="All clear" />
        ) : (
          <Stack direction="row" spacing={0.75}>
            {critical.length > 0 && <Chip size="small" color="error" label={`${critical.length} critical`} />}
            {warning.length > 0 && <Chip size="small" color="warning" label={`${warning.length} warning`} />}
          </Stack>
        )
      }
    >
      {!items.length ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          No operator actions to report.
        </Typography>
      ) : (
        <Box>
          {critical.map((item) => (
            <QueueRow key={item.id} item={item} onNavigate={onNavigate} />
          ))}
          {warning.map((item) => (
            <QueueRow key={item.id} item={item} onNavigate={onNavigate} />
          ))}
          {info.map((item) => (
            <QueueRow key={item.id} item={item} onNavigate={onNavigate} />
          ))}
        </Box>
      )}
    </ConsolePanel>
  );
}
