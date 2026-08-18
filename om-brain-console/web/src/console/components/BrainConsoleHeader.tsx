import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import {
  IconBrain,
  IconMoon,
  IconNetwork,
  IconRefresh,
  IconServer,
  IconShield,
  IconSun,
  IconTerminal,
} from '@tabler/icons-react';

import { deriveFleetEnvironment } from '../../api/brainApi';
import { useColorMode } from '../../theme/ColorModeContext';

import { useBrainConsole } from '../BrainConsoleContext';

function MetaChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof IconServer;
  label: string;
  value: string;
}) {
  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<Icon size={13} />}
      label={
        <span>
          <Typography component="span" variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
            {label}
          </Typography>
          <Typography component="span" variant="caption" fontWeight={700}>
            {value}
          </Typography>
        </span>
      }
    />
  );
}

export default function BrainConsoleHeader({
  onOpenRaw,
}: {
  onOpenRaw: () => void;
}) {
  const theme = useTheme();
  const { mode, toggleColorMode } = useColorMode();
  const { proxyHealth, brainHealth, healthLoading, lastChecked, refreshHealth } = useBrainConsole();

  const proxyOk = proxyHealth?.ok === true;
  const upstreamOk = brainHealth?.ok !== false;
  const healthLabel = proxyOk && upstreamOk ? 'Online' : proxyOk ? 'Degraded' : 'Offline';
  const healthColor = proxyOk && upstreamOk ? 'success' : proxyOk ? 'warning' : 'error';

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: 'divider',
        px: { xs: 2, sm: 3 },
        py: 1.75,
        bgcolor: alpha(theme.palette.background.paper, 0.92),
        backdropFilter: 'blur(10px)',
        position: 'sticky',
        top: 0,
        zIndex: 5,
      }}
    >
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        alignItems={{ lg: 'center' }}
        justifyContent="space-between"
        spacing={1.5}
      >
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box
            sx={{
              width: 42,
              height: 42,
              borderRadius: 1.5,
              background: `linear-gradient(135deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
              color: theme.palette.primary.contrastText,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxShadow: `0 4px 16px ${alpha(theme.palette.primary.main, 0.45)}`,
            }}
          >
            <IconBrain size={22} />
          </Box>
          <Box>
            <Typography variant="h4" sx={{ lineHeight: 1.15 }}>
              OMBrain Command Console
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              Runtime capabilities, skill registry, diagnostics, and governed brain actions
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={healthColor}
            sx={{ fontWeight: 700, px: 0.5 }}
            label={
              <Stack direction="row" alignItems="center" spacing={0.75}>
                <Box
                  sx={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    bgcolor: `${healthColor}.main`,
                    boxShadow: `0 0 6px currentColor`,
                    animation: healthLoading ? 'pulse 1.5s infinite' : undefined,
                  }}
                />
                <span>{healthLabel}</span>
              </Stack>
            }
          />
          {lastChecked && (
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
              Last checked {lastChecked.slice(11, 19)} UTC
            </Typography>
          )}
          <Button
            variant="outlined"
            size="small"
            startIcon={healthLoading ? <CircularProgress size={14} /> : <IconRefresh size={16} />}
            onClick={() => refreshHealth({ manual: true })}
            disabled={healthLoading}
          >
            Refresh
          </Button>
          <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <IconButton
              size="small"
              onClick={toggleColorMode}
              aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5 }}
            >
              {mode === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </IconButton>
          </Tooltip>
          <Button variant="contained" size="small" startIcon={<IconTerminal size={16} />} onClick={onOpenRaw}>
            Open Raw API
          </Button>
        </Stack>
      </Stack>

      <Alert severity="info" sx={{ mt: 1.5, py: 0.4 }}>
        Routes under <code>/brain/*</code> on om-dev are called as <code>/api/brain/brain/*</code> through OMAI.
        Requires <strong>super_admin</strong> session.
      </Alert>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.25 }}>
        <MetaChip
          icon={IconServer}
          label="env"
          value={proxyHealth?.fleet_environment ?? deriveFleetEnvironment(proxyHealth?.brain_endpoint)}
        />
        <MetaChip icon={IconNetwork} label="proxy" value="local proxy" />
        <MetaChip icon={IconShield} label="session" value="super_admin" />
        {proxyHealth?.brain_endpoint && (
          <MetaChip icon={IconServer} label="upstream" value={String(proxyHealth.brain_endpoint)} />
        )}
      </Stack>
    </Box>
  );
}
