import { useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconLoader2,
} from '@tabler/icons-react';

import type { ResultData } from '../types';

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={500} noWrap>
        {value}
      </Typography>
    </Box>
  );
}

const statusConfig = {
  success: { icon: IconCircleCheck, label: 'Success', palette: 'success' as const },
  error: { icon: IconCircleX, label: 'Error', palette: 'error' as const },
  pending: { icon: IconLoader2, label: 'Pending', palette: 'info' as const },
  warning: { icon: IconAlertTriangle, label: 'Warning', palette: 'warning' as const },
};

export default function ResultPanel({
  result,
  emptyHint = 'Run a capability to see structured output here.',
}: {
  result: ResultData | null;
  emptyHint?: string;
}) {
  const theme = useTheme();
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!result) {
    return (
      <Paper
        variant="outlined"
        sx={{
          minHeight: 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 3,
          borderStyle: 'dashed',
        }}
      >
        <Typography variant="body2" color="text.secondary" textAlign="center">
          {emptyHint}
        </Typography>
      </Paper>
    );
  }

  const sc = statusConfig[result.status];
  const StatusIcon = sc.icon;
  const statusColor = theme.palette[sc.palette].main;
  const jsonText = JSON.stringify(result.json, null, 2);

  const copy = () => {
    navigator.clipboard?.writeText(showJson ? jsonText : result.summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap', gap: 1 }}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <StatusIcon size={16} color={statusColor} />
          <Typography variant="caption" fontWeight={600} sx={{ color: statusColor }}>
            {sc.label}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {result.endpoint}
        </Typography>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
          gap: 2,
          p: 2,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Meta label="Request ID" value={result.requestId} />
        <Meta label="Latency" value={`${result.latencyMs} ms`} />
        <Meta label="Timestamp" value={result.timestamp} />
        <Meta label="Method" value={result.endpoint.split(' ')[0]} />
      </Box>

      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Result
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
          {result.summary}
        </Typography>
        {result.error && (
          <Box
            sx={{
              mt: 2,
              p: 1.5,
              borderRadius: 1,
              border: 1,
              borderColor: 'error.light',
              bgcolor: alpha(theme.palette.error.main, 0.08),
            }}
          >
            <Typography variant="caption" fontWeight={600} color="error.main">
              Error detail
            </Typography>
            <Typography variant="caption" color="error.main" display="block">
              {result.error}
            </Typography>
          </Box>
        )}
      </Box>

      <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
        <Button
          fullWidth
          onClick={() => setShowJson((v) => !v)}
          endIcon={
            <IconChevronDown
              size={16}
              style={{ transform: showJson ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}
            />
          }
          sx={{ justifyContent: 'space-between', px: 2, py: 1.25, textTransform: 'none', color: 'text.primary' }}
        >
          Raw JSON
        </Button>
        <Collapse in={showJson}>
          <Box sx={{ borderTop: 1, borderColor: 'divider', bgcolor: alpha(theme.palette.common.black, 0.04) }}>
            <Stack direction="row" justifyContent="flex-end" sx={{ p: 1 }}>
              <Tooltip title={copied ? 'Copied' : 'Copy JSON'}>
                <IconButton size="small" onClick={copy}>
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </IconButton>
              </Tooltip>
            </Stack>
            <Box
              component="pre"
              sx={{
                m: 0,
                px: 2,
                pb: 2,
                maxHeight: 280,
                overflow: 'auto',
                fontSize: '0.75rem',
                fontFamily: 'ui-monospace, monospace',
                color: 'text.secondary',
              }}
            >
              {jsonText}
            </Box>
          </Box>
        </Collapse>
      </Box>
    </Paper>
  );
}
