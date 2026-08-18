import { useState } from 'react';
import {
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { IconSend, IconSparkles } from '@tabler/icons-react';

import { askBrain, type AskMode } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { ASK_EXAMPLES } from '../capabilities';
import { PageHeading } from '../components/ConsolePanel';
import ResultPanel from '../components/ResultPanel';
import SafetyBadge from '../components/SafetyBadge';
import type { ResultData, SafetyLevel } from '../types';

const modes: { id: AskMode; label: string; safety: SafetyLevel }[] = [
  { id: 'auto', label: 'Auto', safety: 'read-only' },
  { id: 'knowledge', label: 'Knowledge', safety: 'read-only' },
  { id: 'technical', label: 'Technical', safety: 'read-only' },
  { id: 'ops', label: 'Ops', safety: 'diagnostic' },
];

export default function AskBrainScreen() {
  const { runBrainCall } = useBrainConsole();
  const [prompt, setPrompt] = useState('when is pascha 2027');
  const [mode, setMode] = useState<AskMode>('auto');
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<ResultData | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    const { result: r } = await runBrainCall({
      endpoint: 'POST /api/brain/brain/ask',
      action: `Ask Brain (${mode})`,
      safety: modes.find((m) => m.id === mode)?.safety ?? 'read-only',
      call: () => askBrain(prompt.trim(), mode, sessionId),
    }, 'thinking');
    setResult(r);
    setBusy(false);
  };

  const activeMode = modes.find((m) => m.id === mode) ?? modes[0];

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Ask Brain"
        description="A controlled prompt interface. Responses are grounded and never execute production actions directly."
      />

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" spacing={1}>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
              {modes.map((m) => (
                <Chip
                  key={m.id}
                  label={m.label}
                  clickable
                  color={mode === m.id ? 'primary' : 'default'}
                  variant={mode === m.id ? 'filled' : 'outlined'}
                  onClick={() => setMode(m.id)}
                />
              ))}
            </Stack>
            <SafetyBadge level={activeMode.safety} />
          </Stack>

          <TextField
            fullWidth
            multiline
            minRows={4}
            label="Question"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && submit()}
          />

          <TextField
            fullWidth
            size="small"
            label="Session ID (optional)"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          />

          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75} alignItems="center">
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <IconSparkles size={14} />
              <Typography variant="caption" color="text.secondary">
                Examples
              </Typography>
            </Stack>
            {ASK_EXAMPLES.map((ex) => (
              <Chip key={ex} size="small" variant="outlined" label={ex} onClick={() => setPrompt(ex)} />
            ))}
          </Stack>

          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              POST /api/brain/brain/ask
            </Typography>
            <Button
              variant="contained"
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <IconSend size={16} />}
              onClick={submit}
              disabled={busy || !prompt.trim()}
            >
              {busy ? 'Asking…' : 'Submit'}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <ResultPanel result={result} emptyHint="OMBrain's structured response will appear here." />
    </Stack>
  );
}
