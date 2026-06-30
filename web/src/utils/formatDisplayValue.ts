/** Fleet inventory summary shape from GET /api/platform/inventory */
export function isFleetInventorySummary(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && 'total_servers' in value
    && 'services_running' in value
    && !('required_healthy' in value);
}

function isPrimitiveLedgerValue(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function isSimpleLedgerArray(value: unknown[]): boolean {
  return value.every((v) => v == null || isPrimitiveLedgerValue(v));
}

/** Compact readable fleet summary for tables and ledger cells. */
export function formatFleetInventorySummaryCompact(value: Record<string, unknown>): string {
  const s = value as Record<string, number>;
  const serverParts = [
    `${s.total_servers ?? 0} total`,
    `${s.online ?? 0} online`,
  ];
  if (s.degraded) serverParts.push(`${s.degraded} degraded`);
  if (s.unknown) serverParts.push(`${s.unknown} unknown`);
  if (s.unreachable) serverParts.push(`${s.unreachable} unreachable`);

  const serviceParts = [`${s.services_running ?? 0} running`];
  if (s.services_failed) serviceParts.push(`${s.services_failed} failed`);
  if (s.services_inactive) serviceParts.push(`${s.services_inactive} inactive`);

  const lines = [
    `Servers: ${serverParts.join(' / ')}`,
    `Services: ${serviceParts.join(' / ')}`,
  ];
  if (s.critical_alerts) lines.push(`Critical alerts: ${s.critical_alerts}`);
  return lines.join(' · ');
}

/** Safe string coercion for event ledger payloads (avoids React error #31). */
export function formatLedgerValue(value: unknown): string {
  if (value == null) return '—';
  if (isPrimitiveLedgerValue(value)) return String(value);
  if (isFleetInventorySummary(value)) return formatFleetInventorySummaryCompact(value);
  if (Array.isArray(value)) {
    if (isSimpleLedgerArray(value)) {
      return value.map((v) => formatLedgerValue(v)).join(', ');
    }
    return `${value.length} items`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '—';
    }
  }
  return String(value);
}

/** Whether a ledger value should use expandable JSON instead of inline text. */
export function isExpandableLedgerValue(value: unknown): boolean {
  if (value == null || isPrimitiveLedgerValue(value) || isFleetInventorySummary(value)) return false;
  if (Array.isArray(value)) return !isSimpleLedgerArray(value);
  return typeof value === 'object';
}

/** Coerce API/UI values to safe React text children (avoids React error #31). */
export function formatDisplayValue(value: unknown): string | number {
  if (value == null) return '—';
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (isFleetInventorySummary(value)) {
    return formatFleetInventorySummaryCompact(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '—';
    }
  }
  return String(value);
}

/** Normalize alert message fields that may arrive as objects from API/cache drift. */
export function formatAlertMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (isFleetInventorySummary(message)) {
    const s = message as Record<string, number>;
    const parts: string[] = [];
    if (s.unreachable) parts.push(`${s.unreachable} unreachable`);
    if (s.services_failed) parts.push(`${s.services_failed} failed services`);
    if (s.critical_alerts) parts.push(`${s.critical_alerts} critical alerts`);
    if (s.degraded) parts.push(`${s.degraded} degraded hosts`);
    return parts.length ? `Platform fleet alert: ${parts.join(', ')}` : 'Platform fleet summary alert';
  }
  if (message == null) return 'Alert';
  return String(formatDisplayValue(message));
}
