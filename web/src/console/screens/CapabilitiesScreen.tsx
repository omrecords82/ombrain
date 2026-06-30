import { Alert, Box, Stack } from '@mui/material';

import { useBrainConsole } from '../BrainConsoleContext';
import CapabilityMatrix from '../components/CapabilityMatrix';
import { PageHeading } from '../components/ConsolePanel';
import VerifiedCapabilitiesPanel from '../components/VerifiedCapabilitiesPanel';
import WarningsBlockersPanel from '../components/WarningsBlockersPanel';
import type { SectionId } from '../types';

export default function CapabilitiesScreen({ onNavigate }: { onNavigate: (id: SectionId) => void }) {
  const { briefing, briefingError } = useBrainConsole();

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Capabilities"
        description="Categorized capability matrix — live readiness from the operator briefing model, with full detail on click."
      />

      {briefingError && !briefing && (
        <Alert severity="warning">
          Live readiness unavailable ({briefingError}). Showing last-known static capability status.
        </Alert>
      )}

      <CapabilityMatrix readiness={briefing?.capability_readiness} onNavigate={onNavigate} />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
          gap: 3,
        }}
      >
        <VerifiedCapabilitiesPanel />
        <WarningsBlockersPanel />
      </Box>
    </Stack>
  );
}
