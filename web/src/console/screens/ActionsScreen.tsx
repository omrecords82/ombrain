import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { IconPlayerPlay, IconRefresh } from '@tabler/icons-react';

import {
  listBrainActions,
  runBrainAction,
  type BrainAction,
} from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { PageHeading } from '../components/ConsolePanel';
import ResultPanel from '../components/ResultPanel';
import SafetyBadge from '../components/SafetyBadge';
import type { ResultData } from '../types';

const DEFAULT_DRAFT_INPUT = `{
  "title": "Example draft work item",
  "category": "om-backend",
  "prefix": "OMOD"
}`;

const riskColor = {
  read: 'success',
  low: 'info',
  medium: 'warning',
  high: 'error',
} as const;

export default function ActionsScreen() {
  const { runBrainCall, refreshHealth } = useBrainConsole();
  const [actions, setActions] = useState<BrainAction[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inputJson, setInputJson] = useState(DEFAULT_DRAFT_INPUT);
  const [commit, setCommit] = useState(false);
  const [runResult, setRunResult] = useState<ResultData | null>(null);
  const [runBusy, setRunBusy] = useState(false);

  const loadActions = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const { result } = await runBrainCall({
      endpoint: 'GET /api/brain/brain/actions',
      action: 'List brain actions',
      safety: 'read-only',
      call: () => listBrainActions(),
    });
    if (result.status === 'error') {
      setListError(result.error ?? result.summary);
      setActions([]);
    } else {
      const data = result.json as { actions?: BrainAction[] };
      const rows = data.actions || [];
      setActions(rows);
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null);
    }
    setListLoading(false);
  }, [runBrainCall]);

  useEffect(() => {
    loadActions();
  }, [loadActions]);

  const selected = actions.find((a) => a.id === selectedId) ?? null;

  const runSelected = async () => {
    if (!selected) return;
    setRunBusy(true);
    let input: unknown = {};
    if (selected.mutation || inputJson.trim()) {
      try {
        input = JSON.parse(inputJson);
      } catch {
        setRunResult({
          status: 'error',
          endpoint: `POST /api/brain/brain/actions/${selected.id}/run`,
          requestId: 'local',
          latencyMs: 0,
          timestamp: new Date().toISOString(),
          summary: 'Input JSON is invalid',
          json: null,
          error: 'Input JSON is invalid',
        });
        setRunBusy(false);
        return;
      }
    }

    const { result } = await runBrainCall(
      {
        endpoint: `POST /api/brain/brain/actions/${selected.id}/run`,
        action: `${commit ? 'Run' : 'Dry-run'} ${selected.id}`,
        safety: selected.mutation ? 'human-gated' : 'read-only',
        call: () =>
          runBrainAction(selected.id, {
            input,
            dry_run: !commit,
            commit,
          }),
      },
      selected.mutation ? 'governance' : 'tool',
    );
    setRunResult(result);
    setRunBusy(false);
    await refreshHealth();
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Infrastructure Actions"
        description="OMAI action bridge — read-only actions run immediately; mutations require dry-run preview then commit."
        actions={
          <Button
            variant="outlined"
            size="small"
            startIcon={listLoading ? <CircularProgress size={14} /> : <IconRefresh size={16} />}
            onClick={loadActions}
            disabled={listLoading}
          >
            Refresh
          </Button>
        }
      />

      <Alert severity="info" variant="outlined">
        Live registry from <code>GET /brain/actions</code>. BRAIN_OPS_JWT is provisioned — JWT bridge drift resolved.
        Plane mirror (<code>plane.issue.create_draft@v1</code>) remains blocked until PLANE_API_TOKEN is set on OMAI.
      </Alert>

      {listError && <Alert severity="error">{listError}</Alert>}

      <Paper variant="outlined">
        {actions.length ? (
          actions.map((a) => (
            <Stack
              key={a.id}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'center' }}
              onClick={() => setSelectedId(a.id)}
              sx={{
                px: 2,
                py: 1.25,
                borderBottom: 1,
                borderColor: 'divider',
                cursor: 'pointer',
                bgcolor: selectedId === a.id ? 'action.selected' : 'transparent',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 220 }}>
                {a.id}
              </Typography>
              <Chip
                size="small"
                label={a.risk}
                color={riskColor[a.risk as keyof typeof riskColor] || 'default'}
                variant="outlined"
              />
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                {a.title}
              </Typography>
              <SafetyBadge level={a.mutation ? 'human-gated' : 'read-only'} />
            </Stack>
          ))
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            {listLoading ? 'Loading actions…' : 'No actions returned from om-brain.'}
          </Typography>
        )}
      </Paper>

      {selected && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" gutterBottom>
            {selected.title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {selected.description}
          </Typography>

          {(selected.mutation || selected.supports_dry_run) && (
            <TextField
              fullWidth
              multiline
              minRows={6}
              label="Input JSON"
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              sx={{ mb: 2 }}
              inputProps={{ style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' } }}
            />
          )}

          {selected.mutation && (
            <FormControlLabel
              control={<Switch checked={commit} onChange={(e) => setCommit(e.target.checked)} />}
              label="Commit (create draft — omit for dry-run preview)"
              sx={{ mb: 2, display: 'block' }}
            />
          )}

          <Button
            variant="contained"
            onClick={runSelected}
            disabled={runBusy}
            startIcon={runBusy ? <CircularProgress size={16} color="inherit" /> : <IconPlayerPlay size={16} />}
          >
            {selected.mutation ? (commit ? 'Run with commit' : 'Dry-run') : 'Run action'}
          </Button>

          <ResultPanel result={runResult} emptyHint="" />
        </Paper>
      )}
    </Stack>
  );
}
