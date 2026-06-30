import { useState } from 'react';
import { Alert, Box, Stack, TextField, Typography, alpha, useTheme } from '@mui/material';
import { IconBook } from '@tabler/icons-react';

import { askTheology } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import CapabilityRunnerCard from '../components/CapabilityRunnerCard';
import { PageHeading } from '../components/ConsolePanel';

export default function TheologyScreen() {
  const theme = useTheme();
  const { runBrainCall } = useBrainConsole();
  const [question, setQuestion] = useState('What is theosis?');

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Theology / Knowledge"
        description="Source-grounded answers with mandatory citations. OMBrain does not issue doctrinal or canonical rulings."
      />

      <Alert
        severity="info"
        icon={<IconBook size={18} />}
        sx={{ bgcolor: alpha(theme.palette.info.main, 0.08) }}
      >
        Answers are retrieval-augmented when BRAIN_THEOLOGY_ENABLED is true on om-dev. Returns{' '}
        <code>503 theology_disabled</code> otherwise.
      </Alert>

      <CapabilityRunnerCard
        title="Grounded Theology Query"
        description="Ask a theology or knowledge question against the configured corpus."
        safety="proposal-only"
        stateBadge={{ label: 'Partial coverage', tone: 'partial' }}
        actionLabel="Ask with citations"
        controls={
          <Stack spacing={2}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Question
              </Typography>
              <TextField
                fullWidth
                size="small"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                sx={{ mt: 0.5 }}
              />
            </Box>
          </Stack>
        }
        onRun={async () => {
          const { result } = await runBrainCall({
            endpoint: 'POST /api/brain/brain/theology/ask',
            action: 'Theology ask',
            safety: 'proposal-only',
            call: () => askTheology(question.trim()),
          }, 'thinking');
          return result;
        }}
      />
    </Stack>
  );
}
