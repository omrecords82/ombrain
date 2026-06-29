'use strict';

/**
 * Lightweight keyword matching for operation suggestions in /brain/ask.
 */

const DOC_SCAN_PATTERNS = [
  /\bscan\s+(the\s+)?documentation\b/i,
  /\brefresh\s+(the\s+)?doc(umentation)?\s*registry\b/i,
  /\bupdate\s+doc[_\s-]?registry\b/i,
  /\bdoc[_\s-]?registry\s+scan\b/i,
  /\bregenerate\s+doc[_\s-]?snapshot\b/i,
];

function matchOperationIntent(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  for (const re of DOC_SCAN_PATTERNS) {
    if (re.test(q)) {
      return {
        operation_id: 'doc-registry-scan',
        title: 'Documentation registry scan',
        reason: 'query matches documentation scan keywords',
        safe_dry_run: true,
        execute_hint: 'Pass execute=true (and commit=true to persist) to run via POST /brain/operations/doc-registry-scan/run',
      };
    }
  }
  return null;
}

module.exports = { matchOperationIntent, DOC_SCAN_PATTERNS };
