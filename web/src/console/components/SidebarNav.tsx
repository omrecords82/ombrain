import { Box, Button, Stack, Typography, alpha, useTheme } from '@mui/material';
import {
  IconBook,
  IconBolt,
  IconCalendar,
  IconDashboard,
  IconDatabase,
  IconGitBranch,
  IconMapPin,
  IconMessage,
  IconPackages,
  IconSchool,
  IconShieldCheck,
  IconStethoscope,
  IconTerminal,
} from '@tabler/icons-react';

import type { SectionId } from '../types';

interface NavItem {
  id: SectionId;
  label: string;
  icon: typeof IconDashboard;
  group: 'Operate' | 'Capabilities' | 'Govern';
}

const items: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: IconDashboard, group: 'Operate' },
  { id: 'ask', label: 'Ask Brain', icon: IconMessage, group: 'Operate' },
  { id: 'calendar', label: 'Calendar & Saints', icon: IconCalendar, group: 'Capabilities' },
  { id: 'theology', label: 'Theology / Knowledge', icon: IconBook, group: 'Capabilities' },
  { id: 'churches', label: 'Church Finder', icon: IconMapPin, group: 'Capabilities' },
  { id: 'skills', label: 'Skills', icon: IconPackages, group: 'Capabilities' },
  { id: 'actions', label: 'Actions', icon: IconBolt, group: 'Capabilities' },
  { id: 'teach', label: 'Teach Skill', icon: IconSchool, group: 'Capabilities' },
  { id: 'diagnostics', label: 'Diagnostics', icon: IconStethoscope, group: 'Govern' },
  { id: 'events', label: 'Event Ledger', icon: IconDatabase, group: 'Govern' },
  { id: 'decisions', label: 'Decisions', icon: IconGitBranch, group: 'Govern' },
  { id: 'governance', label: 'Governance', icon: IconShieldCheck, group: 'Govern' },
  { id: 'raw', label: 'Raw API', icon: IconTerminal, group: 'Govern' },
];

const groups: NavItem['group'][] = ['Operate', 'Capabilities', 'Govern'];

export default function SidebarNav({
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
        p: 1.5,
        bgcolor: alpha(theme.palette.primary.main, 0.03),
        borderRight: 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {groups.map((group) => (
        <Box key={group}>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ px: 1, pb: 0.5, display: 'block', fontSize: '0.65rem' }}
          >
            {group}
          </Typography>
          <Stack spacing={0.25}>
            {items
              .filter((i) => i.group === group)
              .map((item) => {
                const Icon = item.icon;
                const isActive = active === item.id;
                return (
                  <Button
                    key={item.id}
                    onClick={() => onSelect(item.id)}
                    startIcon={<Icon size={16} />}
                    fullWidth
                    sx={{
                      justifyContent: 'flex-start',
                      textTransform: 'none',
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? 'primary.main' : 'text.secondary',
                      bgcolor: isActive ? alpha(theme.palette.primary.main, 0.1) : 'transparent',
                      '&:hover': {
                        bgcolor: isActive
                          ? alpha(theme.palette.primary.main, 0.14)
                          : alpha(theme.palette.action.hover, 0.08),
                      },
                    }}
                  >
                    {item.label}
                  </Button>
                );
              })}
          </Stack>
        </Box>
      ))}

      <Box
        sx={{
          mt: 'auto',
          p: 1.5,
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
          bgcolor: alpha(theme.palette.background.paper, 0.6),
        }}
      >
        <Typography variant="caption" fontWeight={600}>
          Safety boundary
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          OMBrain cannot execute unsafe infrastructure actions directly. Medium and high-risk actions route through
          OMStudio governance.
        </Typography>
      </Box>
    </Box>
  );
}
