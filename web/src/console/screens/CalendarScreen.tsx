import { useState } from 'react';
import { Box, FormControl, Grid, InputLabel, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';

import { brainGet } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import CapabilityCard from '../components/CapabilityCard';
import { PageHeading } from '../components/ConsolePanel';

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack spacing={0.75}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

export default function CalendarScreen() {
  const { runBrainCall } = useBrainConsole();
  const [paschaYear, setPaschaYear] = useState(String(new Date().getFullYear()));
  const [month, setMonth] = useState('12');
  const [day, setDay] = useState('6');
  const [saintYear, setSaintYear] = useState(String(new Date().getFullYear()));

  const track = async (opts: Parameters<typeof runBrainCall>[0]) => {
    const { result } = await runBrainCall(opts);
    return result;
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Calendar & Saints"
        description="Deterministic, read-only liturgical calendar capabilities."
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <CapabilityCard
            title="Pascha Date"
            description="Calculate the date of Pascha for a given year using the Orthodox paschalion."
            safety="read-only"
            actionLabel="Calculate Pascha"
            controls={
              <Field label="Year">
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  value={paschaYear}
                  onChange={(e) => setPaschaYear(e.target.value)}
                />
              </Field>
            }
            onRun={() =>
              track({
                endpoint: `GET /api/brain/brain/calendar/pascha/${paschaYear}`,
                action: `Pascha ${paschaYear}`,
                safety: 'read-only',
                call: () => brainGet(`/calendar/pascha/${encodeURIComponent(paschaYear)}`),
              })
            }
          />
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <CapabilityCard
            title="Today on Old Calendar"
            description="Today's liturgical context on the old calendar."
            safety="read-only"
            actionLabel="Get Today"
            controls={
              <Box sx={{ p: 1.5, border: 1, borderStyle: 'dashed', borderColor: 'divider', borderRadius: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  No inputs required — uses the current server date on om-dev.
                </Typography>
              </Box>
            }
            onRun={() =>
              track({
                endpoint: 'GET /api/brain/brain/calendar/today',
                action: 'Calendar today',
                safety: 'read-only',
                call: () => brainGet('/calendar/today'),
              })
            }
          />
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <CapabilityCard
            title="Saints Commemorations"
            description="Find saints commemorated on a given old-calendar date."
            safety="read-only"
            actionLabel="Find Commemorations"
            controls={
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
                <Field label="Month">
                  <FormControl fullWidth size="small">
                    <InputLabel>Month</InputLabel>
                    <Select label="Month" value={month} onChange={(e) => setMonth(String(e.target.value))}>
                      {months.map((m, i) => (
                        <MenuItem key={m} value={String(i + 1)}>
                          {m}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Field>
                <Field label="Day">
                  <TextField fullWidth size="small" type="number" value={day} onChange={(e) => setDay(e.target.value)} />
                </Field>
                <Field label="Year">
                  <TextField fullWidth size="small" type="number" value={saintYear} onChange={(e) => setSaintYear(e.target.value)} />
                </Field>
              </Box>
            }
            onRun={() => {
              const qs = new URLSearchParams({
                month,
                day,
                calendar: 'old',
                year: saintYear,
              });
              return track({
                endpoint: `GET /api/brain/brain/calendar/saints?${qs}`,
                action: `Saints ${month}/${day}/${saintYear}`,
                safety: 'read-only',
                call: () => brainGet(`/calendar/saints?${qs}`),
              });
            }}
          />
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <CapabilityCard
            title="Fasting Calendar"
            description="Determine fasting rules and rank for a given date."
            safety="read-only"
            stateBadge={{ label: 'Pending engine expansion', tone: 'pending' }}
            actionLabel="Check Fasting Rule"
            disabled
            controls={
              <Box sx={{ p: 1.5, borderRadius: 1, border: 1, borderColor: 'warning.light', bgcolor: 'action.hover' }}>
                <Typography variant="body2" color="warning.main">
                  The fasting rules engine is not yet fully implemented. This capability is surfaced as pending.
                </Typography>
              </Box>
            }
            onRun={async () => ({
              status: 'warning',
              endpoint: 'POST /api/brain/brain/calendar/fasting',
              requestId: 'pending',
              latencyMs: 0,
              timestamp: '',
              summary: 'Fasting engine is pending expansion.',
              json: { status: 'pending' },
            })}
          />
        </Grid>
      </Grid>
    </Stack>
  );
}
