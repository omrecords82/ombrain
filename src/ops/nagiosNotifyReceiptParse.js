'use strict';

/**
 * Parse Nagios local receipt-sink records (CUSTOM / PROBLEM / etc.).
 *
 * Supports:
 * - positional argv from nagios-notify-receipt.sh
 * - structured key=value blocks from notification-receipt.log
 *
 * Preserves raw. Tolerates missing optional fields. Rejects malformed records.
 */

const MARKER_RE = /\b(OMBRAIN-[A-Z0-9:_-]+)\b/i;

function blankRecord(overrides = {}) {
  return {
    ok: true,
    malformed: false,
    error: null,
    notification_type: null,
    host: null,
    service: null,
    state: null,
    author: null,
    comment: null,
    event_timestamp: null,
    test_marker: null,
    command_source: null,
    output: null,
    contact: null,
    raw: null,
    ...overrides,
  };
}

function extractMarker(...parts) {
  for (const p of parts) {
    if (!p) continue;
    const m = String(p).match(MARKER_RE);
    if (m) return m[1];
  }
  return null;
}

function reject(reason, raw) {
  return blankRecord({
    ok: false,
    malformed: true,
    error: reason,
    raw: raw == null ? null : String(raw),
  });
}

/**
 * Parse argv as invoked by Nagios commands.
 *
 * service: <source> <type> <host> <service> <state> <output> [author] [comment] [contact] [event_ts]
 * host:    <source> <type> <host> <state> <output> [author] [comment] [contact] [event_ts]
 */
function parseReceiptArgv(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  const raw = args.join(' ');
  if (args.length < 2) {
    return reject('missing_command_source_or_type', raw);
  }

  const command_source = args[0].toLowerCase();
  if (command_source !== 'service' && command_source !== 'host') {
    return reject('invalid_command_source', raw);
  }

  const notification_type = args[1] || null;
  if (!notification_type) {
    return reject('missing_notification_type', raw);
  }

  let host = null;
  let service = null;
  let state = null;
  let output = null;
  let author = null;
  let comment = null;
  let contact = null;
  let event_timestamp = null;

  if (command_source === 'service') {
    if (args.length < 5) {
      return reject('service_record_too_short', raw);
    }
    host = args[2] || null;
    service = args[3] || null;
    state = args[4] || null;
    output = args[5] || null;
    author = args[6] || null;
    comment = args[7] || null;
    contact = args[8] || null;
    event_timestamp = args[9] || null;
  } else {
    if (args.length < 4) {
      return reject('host_record_too_short', raw);
    }
    host = args[2] || null;
    state = args[3] || null;
    output = args[4] || null;
    author = args[5] || null;
    comment = args[6] || null;
    contact = args[7] || null;
    event_timestamp = args[8] || null;
  }

  if (!host) {
    return reject('missing_host', raw);
  }

  const test_marker = extractMarker(comment, output, author, raw);

  return blankRecord({
    notification_type,
    host,
    service,
    state,
    author: author || null,
    comment: comment || null,
    event_timestamp: event_timestamp || null,
    test_marker,
    command_source,
    output: output || null,
    contact: contact || null,
    raw,
  });
}

/**
 * Parse a structured receipt block (lines of key=value between ---- markers).
 */
function parseReceiptBlock(text) {
  if (text == null || String(text).trim() === '') {
    return reject('empty_block', text);
  }
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '----');

  const map = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1);
    map[key] = val;
  }

  const raw = map.raw != null ? map.raw : lines.join('\n');
  const command_source = (map.command_source || '').toLowerCase() || null;

  // Prefer structured fields; fall back to parsing raw argv when structured empty.
  const structuredMissing =
    !map.host &&
    !map.service &&
    !map.notification_type &&
    !map.type &&
    map.raw;

  if (structuredMissing && map.raw) {
    const fromRaw = parseReceiptArgv(String(map.raw).split(/\s+/));
    if (fromRaw.ok) {
      fromRaw.event_timestamp = map.ts_utc || fromRaw.event_timestamp;
      return fromRaw;
    }
    // If raw argv parse fails, still attempt to salvage what we can below.
  }

  const notification_type = map.notification_type || map.type || null;
  const host = map.host || null;
  const service = map.service || null;
  const state = map.state || map.servicestate || map.hoststate || null;

  if (!notification_type && !host && !map.raw) {
    return reject('malformed_block', raw);
  }
  if (!host) {
    // Legacy broken sink: type may be "service"/"host" and fields empty.
    if (map.raw) {
      const rescued = parseReceiptArgv(String(map.raw).split(/\s+/));
      if (rescued.ok) {
        rescued.event_timestamp = map.ts_utc || rescued.event_timestamp;
        return rescued;
      }
    }
    return reject('missing_host', raw);
  }

  return blankRecord({
    notification_type,
    host,
    service,
    state,
    author: map.author || null,
    comment: map.comment || null,
    event_timestamp: map.ts_utc || map.event_timestamp || null,
    test_marker: map.test_marker || extractMarker(map.comment, map.output, raw),
    command_source:
      command_source ||
      (map.type === 'service' || map.type === 'host' ? map.type : null),
    output: map.output || null,
    contact: map.contact || null,
    raw,
  });
}

module.exports = {
  MARKER_RE,
  parseReceiptArgv,
  parseReceiptBlock,
  extractMarker,
};
