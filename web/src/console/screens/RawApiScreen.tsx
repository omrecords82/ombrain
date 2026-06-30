import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { IconAlertTriangle, IconSend } from '@tabler/icons-react';

import { brainGet, brainPost, brainRootGet, brainRootPost, getProxyHealth } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { ConsolePanel, PageHeading } from '../components/ConsolePanel';
import RecentActivity from '../components/RecentActivity';
import ResultPanel from '../components/ResultPanel';
import type { ResultData } from '../types';

const endpoints = [
  { path: '/api/brain/proxy-health', type: 'proxy-get' as const },
  { path: '/api/brain/health', type: 'root-get' as const },
  { path: '/api/brain/brain/ask', type: 'brain-post' as const, defaultBody: '{"query":"when is pascha 2027"}' },
  { path: '/api/brain/brain/calendar/pascha/2027', type: 'brain-get' as const },
  { path: '/api/brain/brain/calendar/today', type: 'brain-get' as const },
  { path: '/api/brain/status', type: 'root-get' as const },
  { path: '/api/brain/brain/skills', type: 'brain-get' as const },
  { path: '/api/brain/brain/actions', type: 'brain-get' as const },
  {
    path: '/api/brain/brain/teach/skill-proposal',
    type: 'brain-post' as const,
    defaultBody: '{"dry_run":true,"input":{"source":"operator","goal":"Search docs registry"}}',
  },
  { path: '/api/brain/decisions?limit=10', type: 'root-get' as const },
  { path: '/api/brain/governance/health', type: 'root-get' as const },
];

const methods = ['GET', 'POST'] as const;

function pathFromApi(path: string): string {
  if (path.startsWith('/api/brain/brain/')) {
    return path.replace('/api/brain/brain', '');
  }
  if (path.startsWith('/api/brain/')) {
    return path.replace('/api/brain', '');
  }
  return path;
}

export default function RawApiScreen() {
  const { activity, runBrainCall } = useBrainConsole();
  const [method, setMethod] = useState<(typeof methods)[number]>('GET');
  const [endpointIdx, setEndpointIdx] = useState(0);
  const [payload, setPayload] = useState('{\n  "query": "when is pascha 2027"\n}');
  const [result, setResult] = useState<ResultData | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = endpoints[endpointIdx];

  const send = async () => {
    setBusy(true);
    const ep = selected.path;
    const brainPath = pathFromApi(ep);

    const { result: r } = await runBrainCall({
      endpoint: `${method} ${ep}`,
      action: 'Raw API call',
      safety: 'diagnostic',
      call: async () => {
        if (method === 'GET') {
          if (selected.type === 'proxy-get') return getProxyHealth();
          if (selected.type === 'root-get') return brainRootGet(brainPath);
          return brainGet(brainPath);
        }
        let body: unknown = {};
        try {
          body = JSON.parse(payload);
        } catch {
          throw new Error('Payload JSON is invalid');
        }
        if (selected.type === 'root-get') return brainRootPost(brainPath, body);
        return brainPost(brainPath, body);
      },
    });
    setResult(r);
    setBusy(false);
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Raw API"
        description="Super_admin diagnostic tool for issuing direct calls through the OMAI proxy."
      />

      <Alert severity="warning" icon={<IconAlertTriangle size={18} />}>
        This is a <strong>super_admin diagnostic tool</strong>. Calls run under your active session and remain subject
        to OMBrain safety boundaries — unsafe infrastructure actions are still blocked.
      </Alert>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>Method</InputLabel>
              <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {methods.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>Endpoint</InputLabel>
              <Select
                label="Endpoint"
                value={endpointIdx}
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  setEndpointIdx(idx);
                  const def = endpoints[idx].defaultBody;
                  if (def) setPayload(def);
                }}
              >
                {endpoints.map((e, i) => (
                  <MenuItem key={e.path} value={i}>
                    {e.path}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <TextField
            fullWidth
            multiline
            minRows={6}
            label="Payload (JSON)"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            disabled={method === 'GET'}
            inputProps={{ style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' } }}
          />

          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <IconSend size={16} />}
              onClick={send}
              disabled={busy}
            >
              {busy ? 'Sending…' : 'Send request'}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <ResultPanel result={result} emptyHint="Send a request to see the raw response." />

      <ConsolePanel title="Recent session calls" description="Diagnostic requests issued this session">
        <RecentActivity rows={activity} limit={8} />
      </ConsolePanel>

      <Typography variant="caption" color="text.secondary">
        Path rule: Brain routes under <code>/brain/*</code> on om-dev → <code>/api/brain/brain/*</code>. Root routes
        (<code>/diagnose</code>, <code>/decisions</code>) → <code>/api/brain/*</code>.
      </Typography>
    </Stack>
  );
}
