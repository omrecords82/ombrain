/**
 * OMBrain Command Console — operator UI on om-dev (.254).
 * Proxies to local om-brain via /api/brain/* on om-brain-console :8392.
 */

import { useEffect, useState } from 'react';
import { Box, Button, Drawer, Stack } from '@mui/material';
import { IconMenu2 } from '@tabler/icons-react';

import { BrainConsoleProvider, useBrainConsole } from './BrainConsoleContext';
import BrainConsoleHeader from './components/BrainConsoleHeader';
import BrainNavRail from './components/BrainNavRail';
import BrainStatusStrip from './components/BrainStatusStrip';
import AskBrainScreen from './screens/AskBrainScreen';
import ActionsScreen from './screens/ActionsScreen';
import CalendarScreen from './screens/CalendarScreen';
import CapabilitiesScreen from './screens/CapabilitiesScreen';
import ChurchFinderScreen from './screens/ChurchFinderScreen';
import DecisionsScreen from './screens/DecisionsScreen';
import DiagnosticsScreen from './screens/DiagnosticsScreen';
import EventsScreen from './screens/EventsScreen';
import GovernanceScreen from './screens/GovernanceScreen';
import OverviewScreen from './screens/OverviewScreen';
import RawApiScreen from './screens/RawApiScreen';
import SkillsScreen from './screens/SkillsScreen';
import TeachSkillScreen from './screens/TeachSkillScreen';
import TheologyScreen from './screens/TheologyScreen';
import type { SectionId } from './types';

function BrainConsoleShell() {
  const { section, setSection, statusCards, refreshHealth, refreshActivity, refreshBriefing, refreshKey } =
    useBrainConsole();
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    refreshActivity();
  }, [refreshActivity]);

  useEffect(() => {
    refreshBriefing();
  }, [refreshBriefing]);

  const go = (id: SectionId) => {
    setSection(id);
    setMobileNav(false);
  };

  const renderScreen = () => {
    switch (section) {
      case 'overview':
        return <OverviewScreen onNavigate={go} />;
      case 'ask':
        return <AskBrainScreen />;
      case 'capabilities':
        return <CapabilitiesScreen onNavigate={go} />;
      case 'calendar':
        return <CalendarScreen />;
      case 'theology':
        return <TheologyScreen />;
      case 'churches':
        return <ChurchFinderScreen />;
      case 'skills':
        return <SkillsScreen />;
      case 'actions':
        return <ActionsScreen />;
      case 'teach':
        return <TeachSkillScreen />;
      case 'diagnostics':
        return <DiagnosticsScreen />;
      case 'decisions':
        return <DecisionsScreen />;
      case 'events':
        return <EventsScreen />;
      case 'governance':
        return <GovernanceScreen />;
      case 'raw':
        return <RawApiScreen />;
      default:
        return <OverviewScreen onNavigate={go} />;
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        bgcolor: 'background.default',
      }}
    >
      <BrainConsoleHeader onOpenRaw={() => go('raw')} />

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Box
          sx={{
            display: { xs: 'none', lg: 'block' },
            width: 232,
            flexShrink: 0,
          }}
        >
          <BrainNavRail active={section} onSelect={go} />
        </Box>

        <Drawer
          anchor="left"
          open={mobileNav}
          onClose={() => setMobileNav(false)}
          sx={{ display: { lg: 'none' } }}
          PaperProps={{ sx: { width: 260 } }}
        >
          <BrainNavRail active={section} onSelect={go} />
        </Drawer>

        <Box component="main" sx={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <Box
            sx={{
              maxWidth: 1320,
              mx: 'auto',
              p: { xs: 2, sm: 3 },
            }}
          >
            <Button
              variant="outlined"
              size="small"
              startIcon={<IconMenu2 size={16} />}
              onClick={() => setMobileNav(true)}
              sx={{ mb: 2, display: { lg: 'none' } }}
            >
              Sections
            </Button>

            <Box key={refreshKey} sx={{ mb: 3 }}>
              <BrainStatusStrip cards={statusCards} />
            </Box>

            {renderScreen()}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export default function BrainConsolePage() {
  const [section, setSection] = useState<SectionId>('overview');

  return (
    <BrainConsoleProvider section={section} setSection={setSection}>
      <BrainConsoleShell />
    </BrainConsoleProvider>
  );
}
