/**
 * Extract human-readable prose from Brain API responses.
 * Mirrors ombrain CLI formatters where endpoints lack a top-level `answer`.
 */

type JsonObj = Record<string, unknown>;

function asObj(data: unknown): JsonObj | null {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as JsonObj) : null;
}

function formatPascha(b: JsonObj): string {
  if (b.pascha) {
    const disp = b.pascha_display ? ` (${String(b.pascha_display)})` : '';
    return `Pascha ${b.year}: ${b.pascha}${disp}`;
  }
  return '';
}

function formatFasting(b: JsonObj): string {
  const level = b.level != null ? String(b.level) : 'unknown';
  return `${b.date}: ${level}${b.reason ? ` — ${b.reason}` : ''}`;
}

function formatToday(b: JsonObj): string {
  const lines = [`Today ${b.date}`];
  if (b.season) lines.push(`  season: ${b.season}`);
  if (b.fasting && typeof b.fasting === 'object') {
    const f = b.fasting as JsonObj;
    lines.push(`  fasting: ${f.level || 'none'}${f.reason ? ` — ${f.reason}` : ''}`);
  }
  const saints = Array.isArray(b.saints) ? b.saints : [];
  if (saints.length) {
    lines.push(`  saints (${b.saint_count ?? saints.length}):`);
    for (const s of saints.slice(0, 12)) {
      const row = s as JsonObj;
      lines.push(`    • ${row.name ?? 'Unknown'}`);
    }
    if (saints.length > 12) lines.push(`    … and ${saints.length - 12} more`);
  }
  return lines.join('\n');
}

function formatSaints(b: JsonObj): string {
  const cal = b.calendar === 'new' ? 'N.S.' : 'O.S.';
  const lines = [`Saints ${b.date} (${cal}, ${b.year}) — ${b.count ?? 0} commemorated`, ''];
  const saints = Array.isArray(b.saints) ? b.saints : [];
  if (saints.length) {
    for (const s of saints) {
      const row = s as JsonObj;
      lines.push(`  • ${row.name ?? 'Unknown'}`);
    }
  } else {
    lines.push('  (none recorded)');
  }
  return lines.join('\n');
}

function formatChurchFind(b: JsonObj): string {
  const churches = (Array.isArray(b.churches) ? b.churches : Array.isArray(b.results) ? b.results : []) as JsonObj[];
  if (!churches.length) return typeof b.note === 'string' ? b.note : 'No churches found.';
  const lines = [`Found ${churches.length} church(es)`, ''];
  for (const c of churches) {
    lines.push(`  ${c.name ?? 'Unknown'}`);
    if (c.address) lines.push(`    ${c.address}`);
    if (c.jurisdiction) lines.push(`    ${c.jurisdiction}`);
  }
  return lines.join('\n');
}

function formatDiagnose(b: JsonObj): string {
  const lines: string[] = [];
  if (typeof b.recommendation === 'string') lines.push(b.recommendation);
  if (typeof b.verification_steps === 'string') {
    if (lines.length) lines.push('');
    lines.push(`Verification: ${b.verification_steps}`);
  }
  const gov = asObj(b.governance);
  if (gov?.classification) {
    if (lines.length) lines.push('');
    lines.push(`Classification: ${gov.classification}`);
  }
  return lines.join('\n');
}

function formatDecisions(b: JsonObj): string {
  const count = b.count ?? (Array.isArray(b.decisions) ? b.decisions.length : 0);
  return `${count} decision(s) in ledger. Toggle raw JSON for full records.`;
}

function formatAsk(b: JsonObj): string {
  const lines: string[] = [];
  if (b.mode) lines.push(`mode: ${b.mode}`);
  if (b.answer != null) {
    if (lines.length) lines.push('');
    lines.push(typeof b.answer === 'string' ? b.answer : String(b.answer));
  }
  if (typeof b.recommendation === 'string' && b.recommendation !== b.answer) {
    if (lines.length) lines.push('');
    lines.push(`recommendation: ${b.recommendation}`);
  }
  return lines.join('\n');
}

/** Return prose for display, or null when only raw JSON is meaningful. */
export function extractBrainProse(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === 'string') return data;

  const obj = asObj(data);
  if (!obj) return null;

  // Explicit answer string (ask, theology, pipeline handlers)
  if (typeof obj.answer === 'string' && obj.answer.trim()) {
    return obj.mode ? formatAsk(obj) : obj.answer;
  }

  // Nested pipeline detail
  const detail = asObj(obj.detail);
  if (detail && typeof detail.answer === 'string' && detail.answer.trim()) {
    return detail.answer;
  }

  if (typeof obj.recommendation === 'string' && obj.recommendation.trim()) {
    return formatDiagnose(obj) || obj.recommendation;
  }

  // Calendar endpoints
  if (obj.pascha && obj.year) {
    const text = formatPascha(obj);
    if (text) return text;
  }
  if (obj.date && obj.season !== undefined && obj.fasting !== undefined) {
    return formatToday(obj);
  }
  if (obj.date && obj.count !== undefined && Array.isArray(obj.saints)) {
    return formatSaints(obj);
  }
  if (obj.date && obj.level !== undefined) {
    return formatFasting(obj);
  }

  // Church finder
  if (Array.isArray(obj.churches) || Array.isArray(obj.results)) {
    return formatChurchFind(obj);
  }

  // Decisions ledger
  if (Array.isArray(obj.decisions)) {
    return formatDecisions(obj);
  }

  // Theology without answer but with citations
  if (typeof obj.question === 'string' && Array.isArray(obj.citations) && obj.citations.length) {
    return `${obj.citations.length} source(s) found for "${obj.question}". Toggle raw JSON for citations.`;
  }

  return null;
}
