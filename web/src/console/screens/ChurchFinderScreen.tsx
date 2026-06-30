import { useState } from 'react';
import { Alert, Box, Stack, TextField, Typography } from '@mui/material';

import { findChurches } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import CapabilityCard from '../components/CapabilityCard';
import { PageHeading } from '../components/ConsolePanel';

export default function ChurchFinderScreen() {
  const { runBrainCall, proxyHealth } = useBrainConsole();
  const [query, setQuery] = useState('10001');
  const [radius, setRadius] = useState('25');

  const placesBlocked = proxyHealth?.google_places_configured === false;

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Church Finder"
        description="Read-only parish directory lookup by proximity."
      />

      {placesBlocked && (
        <Alert severity="warning">
          Live Google Places is not configured — results use <strong>church_memory</strong> cache only when
          available. Paste <code>GOOGLE_PLACES_API_KEY</code> in OMStudio Platform Secrets to enable live search.
        </Alert>
      )}

      <CapabilityCard
        title="Find Orthodox Parishes"
        description="Locate parishes near a ZIP code, city, or address."
        safety="read-only"
        actionLabel="Find Churches"
        controls={
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '2fr 1fr' }, gap: 2 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Zip, city, or address
              </Typography>
              <TextField fullWidth size="small" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ mt: 0.5 }} />
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Radius (mi)
              </Typography>
              <TextField fullWidth size="small" value={radius} onChange={(e) => setRadius(e.target.value)} sx={{ mt: 0.5 }} />
            </Box>
          </Box>
        }
        onRun={async () => {
          const { result } = await runBrainCall({
            endpoint: 'POST /api/brain/brain/churches/find',
            action: 'Church finder',
            safety: 'read-only',
            call: () => findChurches(query.trim(), Number(radius) || 25),
          });
          return result;
        }}
      />
    </Stack>
  );
}
