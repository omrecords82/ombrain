import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { IconAlertTriangle } from '@tabler/icons-react';

import { listBrainEvents, type BrainEventRecord } from '../../api/brainApi';
import { isFleetInventorySummary } from '../../utils/formatDisplayValue';
import LedgerValueDisplay from './LedgerValueDisplay';

const severityColor = {
  debug: 'default',
  info: 'info',
  warning: 'warning',
  error: 'error',
  critical: 'error',
} as const;

function parsePayload(row: BrainEventRecord): Record<string, unknown> | null {
  if (!row.payload_json) return null;
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractEventSummary(payload: Record<string, unknown> | null, row: BrainEventRecord): unknown {
  if (!payload) return row.event_type ?? null;

  const candidates = [payload.summary, payload.message, payload.data, payload.fleet, payload.inventory];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (isFleetInventorySummary(candidate)) return candidate;
    if (typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = candidate as Record<string, unknown>;
      if (nested.summary != null) return nested.summary;
      if (nested.message != null) return nested.message;
      if (isFleetInventorySummary(nested)) return nested;
    }
  }

  if (typeof payload.event_type === 'string') return payload.event_type;
  return row.event_type ?? null;
}

function formatTime(value?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export default function RawEventsTable({ limit = 100 }: { limit?: number }) {
  const [rows, setRows] = useState<BrainEventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listBrainEvents(limit);
      setRows(data.findings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Box>
      {error && (
        <Alert severity="warning" icon={<IconAlertTriangle size={18} />} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Observed</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Severity</TableCell>
              <TableCell>Correlation</TableCell>
              <TableCell>Summary</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    No ingested events yet. Wire platform emitters or POST to /brain/ingest/event.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const payload = parsePayload(row);
                const summaryValue = extractEventSummary(payload, row);
                const sev = (row.severity || 'info').toLowerCase();
                return (
                  <TableRow key={`${row.id}-${row.observed_at}`} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTime(row.observed_at)}</TableCell>
                    <TableCell>{row.source || '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{row.event_type || '—'}</TableCell>
                    <TableCell>
                      <Chip size="small" label={sev} color={severityColor[sev as keyof typeof severityColor] || 'default'} variant="outlined" />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.72rem' }}>{row.correlation || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 360 }}>
                      <LedgerValueDisplay value={summaryValue} noWrap variant="body2" />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        {loading ? 'Loading…' : `${rows.length} raw events shown (limit ${limit})`}
      </Typography>
    </Box>
  );
}
