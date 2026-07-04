import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  Collapse,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { IconAlertTriangle, IconChevronDown } from '@tabler/icons-react';

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

function payloadEnvelope(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  const ep = payload.event_payload ?? payload.data;
  return ep && typeof ep === 'object' && !Array.isArray(ep) ? (ep as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return v == null || String(v).trim() === '' ? null : String(v);
}

/** Target identity: first-class columns first, payload envelope fallback. */
function rowTarget(row: BrainEventRecord, payload: Record<string, unknown> | null) {
  const ep = payloadEnvelope(payload);
  return {
    name: str(row.target_name) ?? str(ep.target_name) ?? str(ep.host_id),
    ip: str(row.target_ip) ?? str(ep.target_ip) ?? str(ep.ip),
    host: str(row.target_host) ?? str(ep.target_host) ?? str(ep.hostname),
    method: str(row.check_method) ?? str(ep.check_method) ?? str(ep.collector),
    checkedFrom: str(row.checked_from) ?? str(ep.checked_from),
    endpoint: str(ep.check_endpoint) ?? str(ep.endpoint) ?? str(ep.url),
    port: str(ep.target_port) ?? str(ep.port),
    rawError: str(ep.raw_error) ?? str(ep.reason),
    identityStatus: str(row.target_identity_status),
    registryResolution: payload?.registry_resolution ?? null,
  };
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

function DetailLine({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      {label}: <Box component="span" sx={{ fontFamily: 'monospace' }}>{value}</Box>
    </Typography>
  );
}

function EventRow({ row }: { row: BrainEventRecord }) {
  const [open, setOpen] = useState(false);
  const payload = parsePayload(row);
  const summaryValue = extractEventSummary(payload, row);
  const sev = (row.severity || 'info').toLowerCase();
  const target = rowTarget(row, payload);
  const malformed = target.identityStatus === 'malformed';
  const targetLabel = target.name ?? target.host ?? (malformed ? 'Unknown (malformed)' : null);

  return (
    <Fragment>
      <TableRow hover onClick={() => setOpen((v) => !v)} sx={{ cursor: 'pointer' }}>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTime(row.observed_at)}</TableCell>
        <TableCell>
          {targetLabel ? (
            <Typography variant="body2" component="span" color={malformed ? 'warning.main' : undefined}>
              {targetLabel}
            </Typography>
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{target.ip || '—'}</TableCell>
        <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{row.event_type || '—'}</TableCell>
        <TableCell>
          <Chip size="small" label={sev} color={severityColor[sev as keyof typeof severityColor] || 'default'} variant="outlined" />
        </TableCell>
        <TableCell>{row.source || '—'}</TableCell>
        <TableCell sx={{ maxWidth: 300 }}>
          <LedgerValueDisplay value={summaryValue} noWrap variant="body2" />
        </TableCell>
        <TableCell padding="none" align="right">
          <IconButton size="small">
            <IconChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
          </IconButton>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ p: 0, border: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ px: 2, py: 1.5, bgcolor: 'action.hover' }}>
              <DetailLine label="Target name" value={target.name} />
              <DetailLine label="Target IP" value={target.ip} />
              <DetailLine label="Target host" value={target.host} />
              <DetailLine label="Checked from" value={target.checkedFrom} />
              <DetailLine label="Method" value={target.method} />
              <DetailLine label="Endpoint" value={target.endpoint} />
              <DetailLine label="Port" value={target.port} />
              <DetailLine label="Identity status" value={target.identityStatus} />
              <DetailLine
                label="Registry resolution"
                value={target.registryResolution ? JSON.stringify(target.registryResolution) : null}
              />
              <DetailLine label="Correlation" value={str(row.correlation)} />
              <DetailLine label="Correlation ID" value={str(row.correlation_id)} />
              <DetailLine label="Request ID" value={str(row.request_id)} />
              <DetailLine label="Raw error" value={target.rawError} />
              {malformed && (
                <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                  Malformed telemetry — the producer did not identify the affected host and the registry could not
                  resolve it. This event is excluded from normal host incidents.
                </Alert>
              )}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                Full payload:
              </Typography>
              <Box
                component="pre"
                sx={{ m: 0, mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'background.paper', fontSize: '0.7rem', overflowX: 'auto', maxHeight: 260 }}
              >
                {payload ? JSON.stringify(payload, null, 2) : row.payload_json || '—'}
              </Box>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  );
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
              <TableCell>Target</TableCell>
              <TableCell>Target IP</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Severity</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Summary</TableCell>
              <TableCell padding="none" />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    No ingested events yet. Wire platform emitters or POST to /brain/ingest/event.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => <EventRow key={`${row.id}-${row.observed_at}`} row={row} />)
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
