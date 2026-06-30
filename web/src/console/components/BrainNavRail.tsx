import { Box, Stack, Tooltip, Typography, alpha, useTheme } from '@mui/material';
import {
  IconBolt,
  IconBook,
  IconCalendar,
  IconDashboard,
  IconDatabase,
  IconGitBranch,
  IconLayoutGrid,
  IconMapPin,
  IconMessage,
  IconPackages,
  IconSchool,
  IconShieldCheck,
  IconShieldLock,
  IconStethoscope,
  IconTerminal,
} from '@tabler/icons-react';

import type { SectionId } from '../types';

interface NavItem {
  id: SectionId;
  label: string;
  icon: typeof IconDashboard;
}

/** Primary nav — matches the required operator IA exactly. */
const PRIMARY: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: IconDashboard },
  { id: 'ask', label: 'Ask Brain', icon: IconMessage },
  { id: 'capabilities', label: 'Capabilities', icon: IconLayoutGrid },
  { id: 'skills', label: 'Skills', icon: IconPackages },
  { id: 'actions', label: 'Actions', icon: IconBolt },
  { id: 'diagnostics', label: 'Diagnostics', icon: IconStethoscope },
  { id: 'events', label: 'Event Ledger', icon: IconDatabase },
  { id: 'governance', label: 'Governance', icon: IconShieldCheck },
  { id: 'raw', label: 'Raw API', icon: IconTerminal },
];

/** Capability workspaces preserved for continuity — reachable, not removed. */
const WORKSPACES: NavItem[] = [
  { id: 'calendar', label: 'Calendar & Saints', icon: IconCalendar },
  { id: 'theology', label: 'Theology / Knowledge', icon: IconBook },
  { id: 'churches', label: 'Church Finder', icon: IconMapPin },
  { id: 'teach', label: 'Teach Skill', icon: IconSchool },
  { id: 'decisions', label: 'Decisions', icon: IconGitBranch },
];

function NavButton({
  item,
  active,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  onSelect: (id: SectionId) => void;
}) {
  const theme = useTheme();
  const Icon = item.icon;
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(item.id)}
      sx={{
        appearance: 'none',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        width: '100%',
        textAlign: 'left',
        px: 1.25,
        py: 0.9,
        borderRadius: 1.5,
        fontSize: '0.85rem',
        fontWeight: active ? 700 : 500,
        fontFamily: 'inherit',
        color: active ? theme.palette.primary.main : theme.palette.text.secondary,
        bgcolor: active ? alpha(theme.palette.primary.main, 0.14) : 'transparent',
        borderLeft: active ? `3px solid ${theme.palette.primary.main}` : '3px solid transparent',
        transition: 'background-color 0.15s, color 0.15s',
        '&:hover': {
          bgcolor: active ? alpha(theme.palette.primary.main, 0.18) : alpha(theme.palette.text.primary, 0.06),
          color: active ? theme.palette.primary.main : theme.palette.text.primary,
        },
      }}
    >
      <Icon size={17} stroke={active ? 2.1 : 1.8} />
      <Typography component="span" variant="body2" sx={{ fontWeight: 'inherit', color: 'inherit' }} noWrap>
        {item.label}
      </Typography>
    </Box>
  );
}

export default function BrainNavRail({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  const theme = useTheme();

  return (
    <Box
      sx={{
        height: '100%',
        overflowY: 'auto',
        py: 2,
        px: 1.25,
        bgcolor: theme.palette.mode === 'dark' ? alpha('#000000', 0.18) : alpha(theme.palette.primary.main, 0.03),
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        gap: 2.5,
      }}
    >
      <Stack spacing={0.25}>
        {PRIMARY.map((item) => (
          <NavButton key={item.id} item={item} active={active === item.id} onSelect={onSelect} />
        ))}
      </Stack>

      <Box>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ px: 1.25, pb: 0.5, display: 'block' }}
        >
          Workspaces
        </Typography>
        <Stack spacing={0.25}>
          {WORKSPACES.map((item) => (
            <NavButton key={item.id} item={item} active={active === item.id} onSelect={onSelect} />
          ))}
        </Stack>
      </Box>

      <Tooltip
        title="OMBrain cannot execute unsafe infrastructure actions directly. Medium and high-risk actions route through OMStudio governance."
        placement="top"
        arrow
      >
        <Box
          sx={{
            mt: 'auto',
            p: 1.5,
            borderRadius: 1.5,
            border: 1,
            borderColor: alpha(theme.palette.warning.main, 0.35),
            bgcolor: alpha(theme.palette.warning.main, 0.08),
            cursor: 'default',
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <IconShieldLock size={16} color={theme.palette.warning.main} />
            <Typography variant="caption" fontWeight={700} color="warning.main">
              Safety boundary
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5, lineHeight: 1.4 }}>
            No unsafe action execution. Medium/high-risk actions require human-gated governance.
          </Typography>
        </Box>
      </Tooltip>
    </Box>
  );
}
