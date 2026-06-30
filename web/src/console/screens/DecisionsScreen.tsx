import { useState } from 'react';
import { Button, CircularProgress, Stack } from '@mui/material';
import { IconRefresh } from '@tabler/icons-react';

import { brainRootGet } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { ConsolePanel, PageHeading } from '../components/ConsolePanel';
import RecentActivityFeed from '../components/RecentActivityFeed';
import ResultPanel from '../components/ResultPanel';
import type { ResultData } from '../types';

export default function DecisionsScreen() {
  const { activity, runBrainCall } = useBrainConsole();
  const [result, setResult] = useState<ResultData | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDecisions = async () => {
    setBusy(true);
    const { result: r } = await runBrainCall({
      endpoint: 'GET /api/brain/decisions?limit=50',
      action: 'Load decisions ledger',
      safety: 'read-only',
      call: () => brainRootGet('/decisions?limit=50'),
    }, 'governance');
    setResult(r);
    setBusy(false);
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Decision Ledger"
        description="Append-only orchestrator decisions from om-brain decision_memory — not proxy activity or platform event ingest."
        actions={
          <Button
            variant="contained"
            size="small"
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <IconRefresh size={16} />}
            onClick={loadDecisions}
            disabled={busy}
          >
            GET /decisions?limit=50
          </Button>
        }
      />

      <ResultPanel result={result} emptyHint="Load the decision ledger to see governed actions." />

      <ConsolePanel title="Recent Brain Activity" description="Persisted proxy calls (ring buffer)">
        <RecentActivityFeed rows={activity} />
      </ConsolePanel>
    </Stack>
  );
}
