import { useState } from 'react';
import { Alert, Button, Collapse, Paper, Stack, Typography } from '@mui/material';
import { IconChevronDown, IconDatabase } from '@tabler/icons-react';

import { useBrainConsole } from '../BrainConsoleContext';
import EventClustersPanel from '../components/EventClustersPanel';
import { PageHeading } from '../components/ConsolePanel';
import RawEventsTable from '../components/RawEventsTable';

export default function EventsScreen() {
  const { briefing, briefingError, refreshBriefing } = useBrainConsole();
  const [showRaw, setShowRaw] = useState(false);

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Event Ledger"
        description="Clustered, classified operational events from OM, OMAI, OMStudio, and Workshop. Raw rows are available as a drill-down."
        actions={
          <Button variant="outlined" size="small" onClick={() => refreshBriefing()}>
            Refresh
          </Button>
        }
      />

      <Alert severity="info" icon={<IconDatabase size={18} />}>
        <Typography variant="body2" fontWeight={600}>
          Default view: clusters, not raw rows
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Repeated events are grouped by service, event type, severity, and correlation, then classified as signal,
          expected noise, duplicate, low-value audit, or requires attention. Use “View Raw Events” below for the
          unclustered ledger.
        </Typography>
      </Alert>

      {briefingError && !briefing && <Alert severity="warning">{briefingError}</Alert>}

      <EventClustersPanel
        clusters={briefing?.event_clusters ?? []}
        suppressedNoise={briefing?.suppressed_noise ?? []}
      />

      <Paper variant="outlined">
        <Button
          fullWidth
          onClick={() => setShowRaw((v) => !v)}
          endIcon={
            <IconChevronDown size={16} style={{ transform: showRaw ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }} />
          }
          sx={{ justifyContent: 'space-between', px: 2, py: 1.5, textTransform: 'none', color: 'text.primary' }}
        >
          View Raw Events
        </Button>
        <Collapse in={showRaw}>
          <Stack sx={{ p: 2, pt: 0 }}>
            <RawEventsTable limit={100} />
          </Stack>
        </Collapse>
      </Paper>
    </Stack>
  );
}
